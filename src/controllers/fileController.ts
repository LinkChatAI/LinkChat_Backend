import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getBucket } from '../config/gcs.js';
import { env } from '../config/env.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { validateFileUpload, sanitizeFilename } from '../utils/validation.js';
import { z } from 'zod';
import { RoomModel } from '../models/Room.js';
import {
  generateLocalUploadUrl,
  markGcsUnavailable,
  probeGcsHealth,
} from '../services/gcsService.js';
import {
  recordUploadLocal,
  recordUploadGcs,
  recordUploadFailure,
} from '../services/platformMetricsService.js';
import { getStorageLimitForPlan } from '../constants/roomStorage.js';
import { broadcastRoomStorageUpdate } from '../services/roomStorageBroadcast.js';
import { getSettings } from '../services/adminSettingsService.js';

const getUploadUrlSchema = z.object({
  fileName: z.string().min(1),
  fileType: z.string(),
  fileSize: z.number().positive(),
  roomCode: z.string().optional(),
  forceLocal: z.boolean().optional(),
  /** Set when retrying after a failed GCS upload — storage was already reserved. */
  storageReserved: z.boolean().optional(),
});

const MAX_IMAGE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_SIZE_BYTES = 500 * 1024 * 1024;
const MAX_GENERAL_SIZE_BYTES = 300 * 1024 * 1024;
const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads');

const getBackendUrl = (): string => env.BACKEND_URL || 'http://localhost:8080';

const setAttachmentHeaders = (res: Response, fileName: string): void => {
  const safeName = sanitizeFilename(fileName);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
  );
};

type StorageReserveResult =
  | { ok: true }
  | { ok: false; status: number; body: { error: string; message?: string } };

const reserveRoomStorage = async (
  roomCode: string | undefined,
  fileSize: number,
  skipReserve: boolean
): Promise<StorageReserveResult> => {
  if (!roomCode || skipReserve) {
    return { ok: true };
  }

  const room = await RoomModel.findOne({ code: roomCode });
  if (!room) {
    // Room might be ephemeral, just created, or DB reset in dev — skip storage tracking
    // rather than blocking the upload entirely.
    logger.warn('Room not found for storage accounting, proceeding without tracking', { roomCode });
    return { ok: true };
  }

  const storageLimit = getStorageLimitForPlan(room.plan as string | undefined);
  const currentStorageUsed = room.storageUsed || 0;
  if (currentStorageUsed + fileSize > storageLimit) {
    const limitMb = Math.round(storageLimit / (1024 * 1024));
    return {
      ok: false,
      status: 402,
      body: {
        error: 'ROOM_LIMIT_REACHED',
        message: `You have reached the ${limitMb} MB storage limit for this room.`,
      },
    };
  }

  await RoomModel.findByIdAndUpdate(room._id, { $inc: { storageUsed: fileSize } });
  logger.debug('Room storage incremented', {
    roomCode,
    fileSize,
    newStorageUsed: currentStorageUsed + fileSize,
  });
  void broadcastRoomStorageUpdate(roomCode);
  return { ok: true };
};

const respondLocalUpload = async (
  res: Response,
  roomCode: string | undefined,
  sanitizedFileName: string,
  fileSize: number,
  storageReserved: boolean
): Promise<void> => {
  const reserve = await reserveRoomStorage(roomCode, fileSize, storageReserved);
  if (!reserve.ok) {
    res.status(reserve.status).json(reserve.body);
    return;
  }

  const { uploadUrl, filePath } = await generateLocalUploadUrl(
    roomCode || 'shared',
    sanitizedFileName
  );
  const publicUrl = `${getBackendUrl()}/api/uploads/${filePath}`;

  recordUploadLocal();
  res.json({ uploadUrl, publicUrl, storagePath: filePath, isLocal: true });
};

/**
 * POST /api/files/get-upload-url
 * Generates a signed GCS resumable URL, or local PUT URL when GCS is unavailable.
 */
export const getUploadUrlHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = getUploadUrlSchema.parse(req.body);
    const { fileName, fileType, fileSize, roomCode, forceLocal, storageReserved } = body;

    const isVideo = fileType.startsWith('video/');
    const isImage = fileType.startsWith('image/');
    const maxFileSize = isVideo
      ? MAX_VIDEO_SIZE_BYTES
      : isImage
        ? MAX_IMAGE_SIZE_BYTES
        : MAX_GENERAL_SIZE_BYTES;

    if (fileSize > maxFileSize) {
      const maxSizeMB = maxFileSize / (1024 * 1024);
      const fileTypeLabel = isVideo ? 'video' : isImage ? 'image' : 'file';
      res.status(400).json({
        error: `File too large. Maximum size for ${fileTypeLabel} is ${maxSizeMB}MB`,
      });
      return;
    }

    // Video uploads are restricted to premium, pro, and enterprise rooms only
    if (isVideo && roomCode) {
      const room = await RoomModel.findOne({ code: roomCode }).select('plan').lean();
      const plan: string = (room?.plan as string) || 'free';
      const videoPlanAllowed = ['premium', 'pro', 'enterprise'].includes(plan);
      if (!videoPlanAllowed) {
        res.status(403).json({
          error: 'VIDEO_PLAN_REQUIRED',
          message: 'Video sharing is available on Premium and Pro plans only.',
        });
        return;
      }
    }

    // Runtime upload rules (admin dashboard → Settings). In-process cached
    // read; falls back to env.MAX_FILE_SIZE_BYTES / enabled when unset.
    const settings = await getSettings();
    if (!settings.fileUploadsEnabled) {
      res.status(503).json({
        error: 'UPLOADS_DISABLED',
        message: settings.maintenanceMessage || 'File uploads are temporarily disabled.',
      });
      return;
    }

    const maxBytes = settings.maxFileSizeMb * 1024 * 1024;
    if (fileSize > maxBytes) {
      res.status(400).json({
        error: `File size exceeds maximum of ${settings.maxFileSizeMb}MB`,
      });
      return;
    }

    const validation = validateFileUpload(fileName, fileType, fileSize);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const sanitizedFileName = validation.sanitizedFileName!;
    const mimeType =
      fileType === 'application/octet-stream'
        ? fileType
        : validation.inferredMimeType || fileType;

    // Client hit GCS billing/auth on upload — use local only and skip GCS API calls
    if (forceLocal) {
      markGcsUnavailable();
      logger.debug('Local upload URL (forceLocal)', { fileName: sanitizedFileName });
      await respondLocalUpload(res, roomCode, sanitizedFileName, fileSize, !!storageReserved);
      return;
    }

    const bucket = getBucket();
    const gcsHealthy = bucket ? await probeGcsHealth() : false;

    if (!bucket || !gcsHealthy) {
      logger.debug('Local upload URL (GCS unavailable or not configured)', {
        fileName: sanitizedFileName,
      });
      await respondLocalUpload(res, roomCode, sanitizedFileName, fileSize, !!storageReserved);
      return;
    }

    const reserve = await reserveRoomStorage(roomCode, fileSize, !!storageReserved);
    if (!reserve.ok) {
      res.status(reserve.status).json(reserve.body);
      return;
    }

    const fileId = uuidv4();
    const storagePath = roomCode
      ? `rooms/${roomCode}/${fileId}-${sanitizedFileName}`
      : `uploads/${fileId}-${sanitizedFileName}`;

    const file = bucket.file(storagePath);

    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'resumable',
      expires: Date.now() + 15 * 60 * 1000,
      contentType: mimeType,
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

    logger.debug('GCS resumable upload URL generated', {
      fileName: sanitizedFileName,
      fileType: mimeType,
      fileSize,
      isVideo,
      storagePath,
    });

    recordUploadGcs();
    res.json({ uploadUrl, publicUrl, storagePath });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }

    if (error instanceof Error) {
      const errorMessage = error.message;
      if (errorMessage.includes('Failed to generate') || errorMessage.includes('getSignedUrl')) {
        markGcsUnavailable();
        recordUploadFailure();
        logger.warn('GCS signed URL failed — client should retry with forceLocal', {
          error: errorMessage,
        });
        res.status(503).json({
          error: 'Cloud storage temporarily unavailable. Retry will use local storage.',
          code: 'GCS_UPLOAD_URL_ERROR',
        });
        return;
      }
    }

    recordUploadFailure();
    logger.error('Unexpected error generating upload URL', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to generate upload URL',
      code: 'UNKNOWN_ERROR',
    });
  }
};

/**
 * GET /api/files/download?path=rooms/CODE/id-name.pdf&name=file.pdf
 * Streams a file with Content-Disposition: attachment (forces download on tap).
 */
export const downloadFileHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const storagePath = String(req.query.path || '');
    const fileName = String(req.query.name || 'download');

    if (!storagePath || storagePath.includes('..')) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    setAttachmentHeaders(res, fileName);

    const bucket = getBucket();
    const gcsHealthy = bucket ? await probeGcsHealth() : false;

    if (bucket && gcsHealthy) {
      const file = bucket.file(storagePath);
      const [exists] = await file.exists();
      if (!exists) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const [metadata] = await file.getMetadata();
      if (metadata.contentType) {
        res.setHeader('Content-Type', metadata.contentType);
      }

      file
        .createReadStream()
        .on('error', (err) => {
          logger.error('GCS download stream error', {
            error: err instanceof Error ? err.message : String(err),
            storagePath,
          });
          if (!res.headersSent) res.status(500).json({ error: 'Failed to download file' });
        })
        .pipe(res);
      return;
    }

    const fullPath = path.join(LOCAL_UPLOAD_DIR, storagePath);
    const normalizedPath = path.normalize(fullPath);
    if (!normalizedPath.startsWith(path.normalize(LOCAL_UPLOAD_DIR))) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    if (!fs.existsSync(normalizedPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.sendFile(normalizedPath);
  } catch (error: unknown) {
    logger.error('Download file error', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download file' });
    }
  }
};
