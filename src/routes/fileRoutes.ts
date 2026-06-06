import { Router } from 'express';
import { getUploadUrlHandler, downloadFileHandler } from '../controllers/fileController.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Generate signed URL for direct client-to-GCS upload
router.post('/get-upload-url', rateLimiter('uploadUrl'), getUploadUrlHandler);

// Download attachment (Content-Disposition: attachment)
router.get('/download', downloadFileHandler);

export default router;

