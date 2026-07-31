import { getBucket } from '../config/gcs.js';
import { env } from '../config/env.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const getBackendUrl = () => env.BACKEND_URL || 'http://localhost:8080';

// ─── GCS Health Cache ─────────────────────────────────────────────────────────
// We cache the GCS health result so we don't probe on every upload request.
// getSignedUrl() does NOT require billing (signing is local); bucket.getMetadata()
// does require billing, so this probe reliably catches billing failures.

type GcsHealthStatus = 'unknown' | 'healthy' | 'unavailable';
let gcsHealthStatus: GcsHealthStatus = 'unknown';
let gcsHealthCheckedAt = 0;
const GCS_HEALTH_CACHE_MS = 5 * 60 * 1000; // Re-probe every 5 minutes

/**
 * Probe GCS with a real API call to verify billing + auth are working.
 * Result is cached for GCS_HEALTH_CACHE_MS to avoid repeated probing.
 */
/** Mark GCS unavailable (e.g. client reported billing/auth failure on upload). */
export const markGcsUnavailable = (): void => {
  gcsHealthStatus = 'unavailable';
  gcsHealthCheckedAt = Date.now();
};

export const probeGcsHealth = async (): Promise<boolean> => {
  const now = Date.now();

  // Return cached result if still fresh
  if (gcsHealthStatus !== 'unknown' && now - gcsHealthCheckedAt < GCS_HEALTH_CACHE_MS) {
    return gcsHealthStatus === 'healthy';
  }

  const bucket = getBucket();
  if (!bucket) {
    gcsHealthStatus = 'unavailable';
    gcsHealthCheckedAt = now;
    return false;
  }

  try {
    // bucket.getMetadata() makes a real API call — requires billing to be active
    await bucket.getMetadata();
    if (gcsHealthStatus !== 'healthy') {
      logger.info('GCS health probe: healthy — using GCS for file storage');
    }
    gcsHealthStatus = 'healthy';
    gcsHealthCheckedAt = now;
    return true;
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('GCS health probe failed — falling back to local storage', { error: msg });
    gcsHealthStatus = 'unavailable';
    gcsHealthCheckedAt = now;
    return false;
  }
};

// ─── Local Storage Helpers ────────────────────────────────────────────────────

const ensureUploadDir = async () => {
  try {
    await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  } catch (_) { /* ignore */ }
};

export const generateLocalUploadUrl = async (
  roomCode: string,
  fileName: string
): Promise<{ uploadUrl: string; filePath: string }> => {
  await ensureUploadDir();
  const fileId = uuidv4();
  const filePath = `rooms/${roomCode}/${fileId}-${fileName}`;
  // Encode each segment only — do NOT encode slashes (encodeURIComponent on full path breaks Express routing)
  const uploadUrl = `${getBackendUrl()}/api/uploads/${filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
  return { uploadUrl, filePath };
};

const getLocalFileUrl = (filePath: string): string =>
  `${getBackendUrl()}/api/uploads/${filePath}`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an upload URL.
 *
 * Priority:
 *   1. GCS (if configured AND health probe passes — billing + auth must be working)
 *   2. Local storage (automatic hard fallback on ANY GCS issue)
 *
 * NEVER throws due to GCS issues.
 */
export const generateUploadUrl = async (
  roomCode: string,
  fileName: string,
  mimeType: string,
  fileSize: number
): Promise<{ uploadUrl: string; filePath: string; isLocal?: boolean }> => {
  if (fileSize > env.MAX_FILE_SIZE_BYTES) {
    throw new Error(`File size exceeds maximum of ${env.MAX_FILE_SIZE_BYTES} bytes`);
  }

  const gcsHealthy = await probeGcsHealth();

  if (!gcsHealthy) {
    const result = await generateLocalUploadUrl(roomCode, fileName);
    logger.debug('Using local upload (GCS unavailable)', { roomCode, fileName });
    return { ...result, isLocal: true };
  }

  const bucket = getBucket()!;

  try {
    const fileId = uuidv4();
    const filePath = `rooms/${roomCode}/${fileId}-${fileName}`;
    const file = bucket.file(filePath);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType: mimeType,
    });

    logger.debug('GCS upload URL generated', { roomCode, fileName, filePath });
    return { uploadUrl: url, filePath };
  } catch (error: any) {
    // Signing failed despite healthy probe — mark unhealthy and hard-fallback
    logger.warn('GCS getSignedUrl failed — falling back to local storage', {
      error: error instanceof Error ? error.message : String(error),
      roomCode,
      fileName,
    });
    gcsHealthStatus = 'unavailable';
    gcsHealthCheckedAt = Date.now();
    const result = await generateLocalUploadUrl(roomCode, fileName);
    return { ...result, isLocal: true };
  }
};

/**
 * Get the public/serve URL for a stored file.
 * Hard-falls back to local URL if GCS is unavailable.
 * NEVER throws.
 */
export const getFileUrl = (filePath: string): string => {
  if (gcsHealthStatus !== 'healthy') {
    return getLocalFileUrl(filePath);
  }
  const bucket = getBucket();
  if (!bucket) return getLocalFileUrl(filePath);
  return `https://storage.googleapis.com/${bucket.name}/${filePath}`;
};

/**
 * Get a signed inline URL for displaying an image/video.
 * Hard-falls back to local URL on any GCS error.
 * NEVER throws.
 */
export const getImageUrl = async (filePath: string): Promise<string> => {
  if (gcsHealthStatus !== 'healthy') return getLocalFileUrl(filePath);
  const bucket = getBucket();
  if (!bucket) return getLocalFileUrl(filePath);
  try {
    const [url] = await bucket.file(filePath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      responseDisposition: 'inline',
    });
    return url;
  } catch (error: any) {
    logger.warn('GCS getImageUrl failed — using local fallback', {
      error: error instanceof Error ? error.message : String(error),
      filePath,
    });
    gcsHealthStatus = 'unavailable';
    gcsHealthCheckedAt = Date.now();
    return getLocalFileUrl(filePath);
  }
};

/**
 * Get a signed download URL for a file attachment.
 * Hard-falls back to local URL on any GCS error.
 * NEVER throws.
 */
export const getDownloadUrl = async (filePath: string, fileName: string): Promise<string> => {
  if (gcsHealthStatus !== 'healthy') return getLocalFileUrl(filePath);
  const bucket = getBucket();
  if (!bucket) return getLocalFileUrl(filePath);
  try {
    const [url] = await bucket.file(filePath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      responseDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
    });
    return url;
  } catch (error: any) {
    logger.warn('GCS getDownloadUrl failed — using local fallback', {
      error: error instanceof Error ? error.message : String(error),
      filePath,
    });
    gcsHealthStatus = 'unavailable';
    gcsHealthCheckedAt = Date.now();
    return getLocalFileUrl(filePath);
  }
};

/**
 * Expose current GCS health status for fileController to use.
 */
export const isGcsHealthy = (): boolean => gcsHealthStatus === 'healthy';

/**
 * Delete files for a specific room.
 * Failures are logged but never propagated.
 */
export const deleteRoomFiles = async (roomCode: string): Promise<{ gcs: number; local: boolean }> => {
  const result = { gcs: 0, local: false };

  // Both backends are swept unconditionally, never either/or. Uploads fall back
  // to local disk whenever GCS is unhealthy (see uploadFile), so a single room
  // can have objects in both places. Branching on *current* health at delete
  // time would strand whichever backend happens not to be selected right now.
  const bucket = getBucket();
  if (bucket) {
    try {
      const [files] = await bucket.getFiles({ prefix: `rooms/${roomCode}/` });
      if (files.length > 0) {
        await Promise.all(
          files.map((file) =>
            file
              .delete()
              .then(() => {
                result.gcs++;
              })
              .catch((err) =>
                logger.warn(`Failed to delete GCS file: ${file.name}`, { error: err })
              )
          )
        );
        logger.info(`Deleted ${result.gcs} GCS files for room ${roomCode}`);
      }
    } catch (error) {
      logger.warn(`GCS deleteRoomFiles failed for room ${roomCode} (non-critical)`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const roomDir = path.join(LOCAL_UPLOAD_DIR, 'rooms', roomCode);
    await fs.rm(roomDir, { recursive: true, force: true });
    result.local = true;
  } catch (error) {
    logger.warn(`Could not delete local files for room ${roomCode}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
};

/**
 * Whether any file bytes remain for a room, across both backends. Used by the
 * cleanup verifier to assert a purge actually left nothing behind.
 */
export const countRoomFiles = async (roomCode: string): Promise<{ gcs: number; local: number }> => {
  const counts = { gcs: 0, local: 0 };

  const bucket = getBucket();
  if (bucket) {
    try {
      const [files] = await bucket.getFiles({ prefix: `rooms/${roomCode}/` });
      counts.gcs = files.length;
    } catch {
      // Bucket unreachable — report -1 so the verifier treats this backend as
      // unverified rather than silently counting it as clean.
      counts.gcs = -1;
    }
  }

  try {
    const entries = await fs.readdir(path.join(LOCAL_UPLOAD_DIR, 'rooms', roomCode));
    counts.local = entries.length;
  } catch {
    counts.local = 0; // ENOENT means the directory is gone, which is what we want
  }

  return counts;
};
