import { Router } from 'express';
import { getUploadUrlHandler } from '../controllers/fileController.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Generate signed URL for direct client-to-GCS upload
router.post('/get-upload-url', rateLimiter('uploadUrl'), getUploadUrlHandler);

export default router;

