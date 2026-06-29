import { env } from '../config/env.js';

const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || '10000', 10);
const MAX_MESSAGE_WITH_DATA_URL = 15 * 1024 * 1024; // 15MB for data URLs (base64 encoded files) - allows ~10MB files after base64 encoding

// Allowed MIME types for file uploads
const ALLOWED_MIME_TYPES = [
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/html',
  'text/csv',
  'text/xml',
  'application/xml',
  // JSON files
  'application/json',
  'text/json',
  // Archives
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  // Executables
  'application/x-msdownload', // .exe files
  // Subtitle files
  'application/x-subrip', // .srt files
  // CRITICAL: Universal fallback for binary files to prevent Google Cloud signature mismatches
  // This is required for RAR, ZIP, SRT, EXE, and other binary files that browsers may send as octet-stream
  'application/octet-stream',
  // Audio/Video
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'video/webm',
];

export const validateMessageSize = (content: string): { valid: boolean; error?: string } => {
  // Check if message contains a data URL (file upload fallback)
  const isDataUrl = content.includes('[File:') && content.includes('](data:');
  
  if (isDataUrl) {
    // Allow larger messages for data URLs (base64 encoded files)
    if (content.length > MAX_MESSAGE_WITH_DATA_URL) {
      return {
        valid: false,
        error: `File is too large for data URL embedding. Maximum: ${MAX_MESSAGE_WITH_DATA_URL / 1024 / 1024}MB`,
      };
    }
  } else {
    // Normal message length limit
    if (content.length > MAX_MESSAGE_LENGTH) {
      return {
        valid: false,
        error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`,
      };
    }
  }
  
  return { valid: true };
};

export const validateFileSize = (fileSize: number): { valid: boolean; error?: string } => {
  if (fileSize > env.MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File size exceeds maximum of ${env.MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
    };
  }
  if (fileSize <= 0) {
    return {
      valid: false,
      error: 'File size must be greater than 0',
    };
  }
  return { valid: true };
};

/**
 * Infer MIME type from file extension
 */
const inferMimeTypeFromExtension = (fileName: string): string | null => {
  const ext = fileName.toLowerCase().split('.').pop();
  if (!ext) return null;
  
  const mimeMap: Record<string, string> = {
    // Images
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
    'heic': 'image/heic', 'heif': 'image/heif', 'bmp': 'image/bmp',
    // Documents
    'pdf': 'application/pdf', 'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    'ods': 'application/vnd.oasis.opendocument.spreadsheet',
    'csv': 'text/csv', 'tsv': 'text/tab-separated-values',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'odp': 'application/vnd.oasis.opendocument.presentation',
    'odt': 'application/vnd.oasis.opendocument.text',
    'txt': 'text/plain', 'md': 'text/markdown', 'rtf': 'application/rtf',
    'html': 'text/html', 'htm': 'text/html', 'xml': 'application/xml',
    'json': 'application/json', 'yaml': 'text/yaml', 'yml': 'text/yaml',
    // Archives
    'zip': 'application/zip', 'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed', 'tar': 'application/x-tar', 'gz': 'application/gzip',
    // Apps / installers
    'apk': 'application/vnd.android.package-archive',
    'aab': 'application/x-authorware-bin',
    'ipa': 'application/octet-stream',
    'exe': 'application/x-msdownload', 'msi': 'application/x-msdownload',
    'dmg': 'application/x-apple-diskimage',
    // Subtitle / misc
    'srt': 'application/x-subrip', 'vtt': 'text/vtt',
    // Audio/Video
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4',
    'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime', 'mkv': 'video/x-matroska',
  };
  return mimeMap[ext] || null;
};

export const validateMimeType = (mimeType: string, fileName?: string): { valid: boolean; error?: string; inferredMimeType?: string } => {
  // CRITICAL: If application/octet-stream is explicitly provided, use it as-is
  // This is our intentional "universal fallback" for binary files to prevent signature mismatches
  // Do NOT infer a different type, as that would cause the signed URL to use a different Content-Type
  // than what the browser will send, resulting in 403 Forbidden errors
  if (mimeType === 'application/octet-stream') {
    // Use the provided type directly - don't infer
    // This ensures the signed URL matches what the browser will send
  } else if (!mimeType && fileName) {
    const inferred = inferMimeTypeFromExtension(fileName);
    return {
      valid: true,
      inferredMimeType: inferred || 'application/octet-stream',
    };
  }

  // Allow common browser media types, documents, archives, apps (apk, exe), and generic binaries
  const isAllowed = Boolean(
    mimeType &&
      (
        ALLOWED_MIME_TYPES.includes(mimeType) ||
        mimeType.startsWith('image/') ||
        mimeType.startsWith('video/') ||
        mimeType.startsWith('audio/') ||
        mimeType.startsWith('text/') ||
        mimeType.startsWith('application/') ||
        mimeType === 'application/octet-stream'
      )
  );

  if (!isAllowed) {
    return {
      valid: false,
      error: `File type ${mimeType || 'unknown'} is not allowed.`,
    };
  }
  return { valid: true };
};

/**
 * Sanitize filename to prevent directory traversal and special characters
 */
export const sanitizeFilename = (filename: string): string => {
  // Remove directory separators and parent directory references
  let sanitized = filename
    .replace(/\.\./g, '') // Remove ..
    .replace(/[\/\\]/g, '-') // Replace / and \ with -
    .replace(/[<>:"|?*]/g, '') // Remove Windows reserved characters
    .trim();

  // Extract base name and extension
  const lastDot = sanitized.lastIndexOf('.');
  if (lastDot === -1) {
    sanitized = sanitized.substring(0, 200); // Limit length
    return sanitized || 'file';
  }

  const baseName = sanitized.substring(0, lastDot);
  const extension = sanitized.substring(lastDot);

  // Limit base name length
  const limitedBase = baseName.substring(0, 200 - extension.length);

  return (limitedBase || 'file') + extension;
};

/**
 * Validate and sanitize file upload data
 * NOTE: File size validation should be done separately before calling this function
 * (size limits vary by file type - videos can be larger than images)
 */
export const validateFileUpload = (
  fileName: string,
  mimeType: string,
  fileSize: number
): { valid: boolean; error?: string; sanitizedFileName?: string; inferredMimeType?: string } => {
  // File size validation is now done in fileController.ts with type-specific limits
  // (videos: 500MB, images: 25MB, others: 300MB)
  // We only validate that size > 0 here
  if (fileSize <= 0) {
    return {
      valid: false,
      error: 'File size must be greater than 0',
    };
  }

  const mimeValidation = validateMimeType(mimeType, fileName);
  if (!mimeValidation.valid) {
    return mimeValidation;
  }

  const sanitizedFileName = sanitizeFilename(fileName);
  if (!sanitizedFileName || sanitizedFileName === 'file') {
    return {
      valid: false,
      error: 'Invalid filename',
    };
  }

  return {
    valid: true,
    sanitizedFileName,
    inferredMimeType: mimeValidation.inferredMimeType,
  };
};
