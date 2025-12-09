import { getBucket } from '../config/gcs';
import { env } from '../config/env';
import { v4 as uuidv4 } from 'uuid';

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
    throw new Error('GCS not configured');
  }

  const fileId = uuidv4();
  const filePath = `rooms/${roomCode}/${fileId}-${fileName}`;
  const file = bucket.file(filePath);

  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    contentType: mimeType,
  });

  return { uploadUrl: url, filePath };
};

export const getFileUrl = (filePath: string): string => {
  const bucket = getBucket();
  if (!bucket) {
    throw new Error('GCS not configured');
  }
  return `https://storage.googleapis.com/${bucket.name}/${filePath}`;
};

