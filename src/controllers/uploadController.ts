import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads');

/** Resolve storage-relative path from PUT /api/uploads/... (mounted or full path). */
const resolveUploadRelativePath = (req: Request): string | null => {
  // Mounted at /api/uploads → req.path is e.g. /rooms/CODE/id-name.pdf
  // Legacy URLs may still include /api/uploads/ prefix
  const candidates = [req.path, req.url.split('?')[0]];
  const uploadPrefix = '/api/uploads/';

  for (const raw of candidates) {
    if (!raw) continue;
    let relative = raw;
    if (relative.startsWith(uploadPrefix)) {
      relative = relative.slice(uploadPrefix.length);
    } else if (relative.startsWith('/')) {
      relative = relative.slice(1);
    }
    if (relative && !relative.includes('..')) {
      return decodeURIComponent(relative);
    }
  }
  return null;
};

export const uploadFileHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const decodedFilePath = resolveUploadRelativePath(req);

    if (!decodedFilePath) {
      res.status(400).json({ error: 'Invalid upload path' });
      return;
    }
    
    // Ensure the file path is within the uploads directory (security)
    const fullPath = path.join(LOCAL_UPLOAD_DIR, decodedFilePath);
    const normalizedPath = path.normalize(fullPath);
    
    if (!normalizedPath.startsWith(path.normalize(LOCAL_UPLOAD_DIR))) {
      logger.warn('Attempted to upload file outside uploads directory', { decodedFilePath });
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    // Ensure the directory exists
    const dir = path.dirname(normalizedPath);
    await fs.mkdir(dir, { recursive: true });

    // Write the file
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    await fs.writeFile(normalizedPath, buffer);

    logger.debug('File uploaded successfully', { filePath: decodedFilePath, size: buffer.length });
    res.status(200).send('OK');
  } catch (error: any) {
    logger.error('Error uploading file', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      filePath: req.params.filePath,
    });
    res.status(500).json({ 
      error: 'Failed to upload file',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

