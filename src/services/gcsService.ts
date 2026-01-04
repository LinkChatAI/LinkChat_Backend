import { getBucket } from '../config/gcs.js';
import { env } from '../config/env.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// Ensure local upload directory exists
const ensureUploadDir = async () => {
  try {
    await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  } catch (error) {
    logger.warn('Could not create upload directory', { error });
  }
};

export const generateUploadUrl = async (
  roomCode: string,
  fileName: string,
  mimeType: string,
  fileSize: number
): Promise<{ uploadUrl: string; filePath: string }> => {
  if (fileSize > env.MAX_FILE_SIZE_BYTES) {
    throw new Error(`File size exceeds maximum of ${env.MAX_FILE_SIZE_BYTES} bytes`);
  }

  const bucket = getBucket();
  if (!bucket) {
    // GCS not configured - use local file storage fallback
    await ensureUploadDir();
    
    const fileId = uuidv4();
    const filePath = `rooms/${roomCode}/${fileId}-${fileName}`;
    
    // Generate local upload URL - use BACKEND_URL if available, otherwise construct from request
    const backendUrl = env.BACKEND_URL || 'http://localhost:8080';
    const uploadUrl = `${backendUrl}/api/uploads/${encodeURIComponent(filePath)}`;
    
    logger.debug('Local upload URL generated (GCS not configured)', { roomCode, fileName, filePath });
    return { uploadUrl, filePath };
  }

  try {
    const fileId = uuidv4();
    const filePath = `rooms/${roomCode}/${fileId}-${fileName}`;
    const file = bucket.file(filePath);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType: mimeType,
    });

    logger.debug('GCS upload URL generated successfully', { roomCode, fileName, filePath });
    return { uploadUrl: url, filePath };
  } catch (error: any) {
    logger.error('Error generating GCS signed URL', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      roomCode,
      fileName,
    });
    throw new Error(`Failed to generate GCS upload URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

export const getFileUrl = (filePath: string): string => {
  const bucket = getBucket();
  if (!bucket) {
    // Local fallback
    return `/uploads/${filePath}`;
  }
  return `https://storage.googleapis.com/${bucket.name}/${filePath}`;
};

export const getDownloadUrl = async (filePath: string, fileName: string): Promise<string> => {
  const bucket = getBucket();
  if (!bucket) {
    // Local fallback
    return `/uploads/${filePath}`;
  }
  const file = bucket.file(filePath);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    responseDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
  });
  return url;
};

export const getImageUrl = async (filePath: string): Promise<string> => {
  const bucket = getBucket();
  if (!bucket) {
    // Local fallback
    return `/uploads/${filePath}`;
  }
  const file = bucket.file(filePath);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    responseDisposition: 'inline',
  });
  return url;
};

/**
 * Delete files for a specific room from GCS or local storage
 */
export const deleteRoomFiles = async (roomCode: string): Promise<void> => {
  const bucket = getBucket();
  
  if (bucket) {
    // Delete from GCS
    try {
      const [files] = await bucket.getFiles({ prefix: `rooms/${roomCode}/` });
      
      if (files.length > 0) {
        await Promise.all(files.map(file => file.delete().catch(err => {
          logger.warn(`Failed to delete GCS file: ${file.name}`, { error: err });
        })));
        logger.info(`Deleted ${files.length} files from GCS for room ${roomCode}`);
      }
    } catch (error) {
      logger.error(`Error deleting GCS files for room ${roomCode}`, { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  } else {
    // Delete from local storage
    try {
      const roomDir = path.join(LOCAL_UPLOAD_DIR, 'rooms', roomCode);
      await fs.rm(roomDir, { recursive: true, force: true });
      logger.info(`Deleted local files for room ${roomCode}`);
    } catch (error) {
      logger.warn(`Could not delete local files for room ${roomCode}`, { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
};

