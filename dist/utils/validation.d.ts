export declare const validateMessageSize: (content: string) => {
    valid: boolean;
    error?: string;
};
export declare const validateFileSize: (fileSize: number) => {
    valid: boolean;
    error?: string;
};
export declare const validateMimeType: (mimeType: string, fileName?: string) => {
    valid: boolean;
    error?: string;
    inferredMimeType?: string;
};
/**
 * Sanitize filename to prevent directory traversal and special characters
 */
export declare const sanitizeFilename: (filename: string) => string;
/**
 * Validate and sanitize file upload data
 */
export declare const validateFileUpload: (fileName: string, mimeType: string, fileSize: number) => {
    valid: boolean;
    error?: string;
    sanitizedFileName?: string;
    inferredMimeType?: string;
};
//# sourceMappingURL=validation.d.ts.map