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
    'text/csv',
    // Archives
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    // Audio/Video
    'audio/mpeg',
    'audio/wav',
    'video/mp4',
    'video/webm',
];
export const validateMessageSize = (content) => {
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
    }
    else {
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
export const validateFileSize = (fileSize) => {
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
const inferMimeTypeFromExtension = (fileName) => {
    const ext = fileName.toLowerCase().split('.').pop();
    if (!ext)
        return null;
    const mimeMap = {
        // Images
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
        // Documents
        'pdf': 'application/pdf', 'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'txt': 'text/plain', 'csv': 'text/csv',
        // Archives
        'zip': 'application/zip', 'rar': 'application/x-rar-compressed',
        // Audio/Video
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'mp4': 'video/mp4', 'webm': 'video/webm',
    };
    return mimeMap[ext] || null;
};
export const validateMimeType = (mimeType, fileName) => {
    // If MIME type is empty or the generic fallback, try to infer from filename
    if ((!mimeType || mimeType === 'application/octet-stream') && fileName) {
        const inferred = inferMimeTypeFromExtension(fileName);
        if (inferred && ALLOWED_MIME_TYPES.includes(inferred)) {
            return { valid: true, inferredMimeType: inferred };
        }
    }
    // Validate provided MIME type
    if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
        return {
            valid: false,
            error: `File type ${mimeType || 'unknown'} is not allowed. Allowed types: images, documents, archives, audio/video.`,
        };
    }
    return { valid: true };
};
/**
 * Sanitize filename to prevent directory traversal and special characters
 */
export const sanitizeFilename = (filename) => {
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
 */
export const validateFileUpload = (fileName, mimeType, fileSize) => {
    const sizeValidation = validateFileSize(fileSize);
    if (!sizeValidation.valid) {
        return sizeValidation;
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
//# sourceMappingURL=validation.js.map