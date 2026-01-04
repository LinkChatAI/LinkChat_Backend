jest.mock('../../config/env.js', () => ({
  env: {
    MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  },
}));

import { validateFileUpload, validateMimeType, validateFileSize, sanitizeFilename } from '../validation.js';
import { env } from '../../config/env.js';

describe('File Validation', () => {
  describe('validateFileUpload', () => {
    it('should accept valid image files', () => {
      const result = validateFileUpload('test.jpg', 'image/jpeg', 1024);
      expect(result.valid).toBe(true);
      expect(result.sanitizedFileName).toBe('test.jpg');
    });

    it('should accept Excel files', () => {
      const result = validateFileUpload('data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 2048);
      expect(result.valid).toBe(true);
      expect(result.sanitizedFileName).toBe('data.xlsx');
    });

    it('should accept PPT files', () => {
      const result = validateFileUpload('presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 4096);
      expect(result.valid).toBe(true);
      expect(result.sanitizedFileName).toBe('presentation.pptx');
    });

    it('should accept old PPT format', () => {
      const result = validateFileUpload('old.ppt', 'application/vnd.ms-powerpoint', 2048);
      expect(result.valid).toBe(true);
      expect(result.sanitizedFileName).toBe('old.ppt');
    });

    it('should reject files exceeding size limit', () => {
      const result = validateFileUpload('large.jpg', 'image/jpeg', env.MAX_FILE_SIZE_BYTES + 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum');
    });

    it('should reject invalid MIME types', () => {
      const result = validateFileUpload('script.exe', 'application/x-msdownload', 1024);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    it('should infer MIME type from extension when missing', () => {
      const result = validateFileUpload('document.pdf', 'application/octet-stream', 1024);
      expect(result.valid).toBe(true);
      expect(result.inferredMimeType).toBe('application/pdf');
    });

    it('should sanitize dangerous filenames', () => {
      const result = validateFileUpload('../../../etc/passwd.txt', 'text/plain', 1024);
      expect(result.valid).toBe(true);
      expect(result.sanitizedFileName).not.toContain('../');
      expect(result.sanitizedFileName).not.toContain('/');
    });

    it('should sanitize Windows reserved characters', () => {
      const result = validateFileUpload('file<>:"|?*.txt', 'text/plain', 1024);
      expect(result.valid).toBe(true);
      expect(result.sanitizedFileName).not.toMatch(/[<>:"|?*]/);
    });
  });

  describe('validateMimeType', () => {
    it('should accept image MIME types', () => {
      expect(validateMimeType('image/jpeg').valid).toBe(true);
      expect(validateMimeType('image/png').valid).toBe(true);
      expect(validateMimeType('image/gif').valid).toBe(true);
      expect(validateMimeType('image/webp').valid).toBe(true);
    });

    it('should accept document MIME types', () => {
      expect(validateMimeType('application/pdf').valid).toBe(true);
      expect(validateMimeType('application/vnd.ms-excel').valid).toBe(true);
      expect(validateMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').valid).toBe(true);
      expect(validateMimeType('application/vnd.ms-powerpoint').valid).toBe(true);
      expect(validateMimeType('application/vnd.openxmlformats-officedocument.presentationml.presentation').valid).toBe(true);
    });

    it('should reject executable files', () => {
      expect(validateMimeType('application/x-msdownload').valid).toBe(false);
      expect(validateMimeType('application/x-executable').valid).toBe(false);
    });
  });

  describe('validateFileSize', () => {
    it('should accept files within limit', () => {
      expect(validateFileSize(1024).valid).toBe(true);
      expect(validateFileSize(env.MAX_FILE_SIZE_BYTES).valid).toBe(true);
    });

    it('should reject files exceeding limit', () => {
      const result = validateFileSize(env.MAX_FILE_SIZE_BYTES + 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum');
    });

    it('should reject empty files', () => {
      const result = validateFileSize(0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('greater than 0');
    });

    it('should reject negative file sizes', () => {
      const result = validateFileSize(-1);
      expect(result.valid).toBe(false);
    });
  });

  describe('sanitizeFilename', () => {
    it('should remove directory traversal', () => {
      expect(sanitizeFilename('../../../etc/passwd')).not.toContain('../');
    });

    it('should remove path separators', () => {
      expect(sanitizeFilename('path/to/file.txt')).not.toContain('/');
      expect(sanitizeFilename('path\\to\\file.txt')).not.toContain('\\');
    });

    it('should preserve valid filenames', () => {
      expect(sanitizeFilename('my-file.txt')).toBe('my-file.txt');
      expect(sanitizeFilename('document_2024.pdf')).toBe('document_2024.pdf');
    });
  });
});

