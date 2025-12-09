import { Request, Response } from 'express';
import { createRoom, getRoomByCode, getRoomBySlugOrCode } from '../services/roomService';
import { generateUploadUrl, getFileUrl } from '../services/gcsService';
import { isFileUploadAvailable } from '../config/gcs';
import { AuthRequest } from '../middleware/auth';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { validateFileUpload } from '../utils/validation';
import { CreateRoomRequest } from '../types';
import { sanitizeName } from '../utils/sanitize';

const createRoomSchema = z.object({
  name: z.string().max(100).optional(),
  isPublic: z.boolean().optional(),
});

const uploadUrlSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  fileSize: z.number().positive(),
});

export const createRoomHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = createRoomSchema.parse(req.body);
    const data: CreateRoomRequest = {
      name: body.name ? sanitizeName(body.name) : undefined,
      isPublic: body.isPublic || false,
    };
    const room = await createRoom(data);
    logger.info('Room created', { code: room.code, slug: room.slug });
    res.json({
      code: room.code,
      token: room.token,
      slug: room.slug,
      name: room.name,
      expiresAt: room.expiresAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid create room request', { errors: error.errors });
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    logger.error('Error creating room', { error });
    res.status(500).json({ error: 'Failed to create room' });
  }
};

export const getRoomHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slugOrCode } = req.params;
    const room = await getRoomBySlugOrCode(slugOrCode);

    if (!room) {
      logger.warn('Room not found', { slugOrCode });
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    if (new Date() > room.expiresAt) {
      logger.warn('Room expired', { code: room.code });
      res.status(410).json({ error: 'Room expired' });
      return;
    }

    logger.debug('Room details requested', { code: room.code });
    res.json({
      code: room.code,
      slug: room.slug,
      name: room.name,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      participantCount: room.participants.length,
      fileUploadAvailable: isFileUploadAvailable(),
    });
  } catch (error) {
    logger.error('Error getting room', { error });
    res.status(500).json({ error: 'Failed to get room' });
  }
};

export const generateUploadUrlHandler = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { code } = req.params;
    if (req.roomCode !== code) {
      logger.warn(`Unauthorized upload URL request for room ${code}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const body = uploadUrlSchema.parse(req.body);
    
    const validation = validateFileUpload(body.fileName, body.mimeType, body.fileSize);
    if (!validation.valid) {
      logger.warn('File validation failed', { code, error: validation.error });
      res.status(400).json({ error: validation.error });
      return;
    }

    const sanitizedFileName = validation.sanitizedFileName!;
    const { uploadUrl, filePath } = await generateUploadUrl(
      code,
      sanitizedFileName,
      body.mimeType,
      body.fileSize
    );

    logger.debug(`Upload URL generated for room ${code}: ${body.fileName}`);
    res.json({ uploadUrl, filePath });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid upload URL request body:', error.errors);
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    
    // Handle GCS not configured error specifically
    if (error instanceof Error && error.message === 'GCS not configured') {
      logger.warn('File upload requested but GCS is not configured', { code: req.params.code });
      res.status(503).json({ error: 'File uploads are not available. GCS storage is not configured.' });
      return;
    }
    
    logger.error('Error generating upload URL:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      code: req.params.code,
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate upload URL' });
  }
};

