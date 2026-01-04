import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads');

export const uploadFileHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    // Extract file path from the request URL
    // The URL is like /api/uploads/rooms/1234/file-id-filename.jpg
    const urlPath = req.path;
    const uploadPrefix = '/api/uploads/';
    
    if (!urlPath.startsWith(uploadPrefix)) {
      res.status(400).json({ error: 'Invalid upload path' });
      return;
    }
    
    // Extract the file path after /api/uploads/
    const filePath = urlPath.substring(uploadPrefix.length);
    
    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    // Decode the file path (it's URL encoded)
    const decodedFilePath = decodeURIComponent(filePath);
    
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

