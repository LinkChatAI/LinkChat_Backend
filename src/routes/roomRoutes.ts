import { Router } from 'express';
import {
  createRoomHandler,
  getRoomHandler,
  generateUploadUrlHandler,
} from '../controllers/roomController';
import { getShareMetaHandler } from '../controllers/seoController';
import { authenticateRoom } from '../middleware/auth';
import { rateLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/', rateLimiter('createRoom'), createRoomHandler);
router.get('/:slugOrCode', rateLimiter('getRoom'), getRoomHandler);
router.get('/:slugOrCode/sharemeta', rateLimiter('getRoom'), getShareMetaHandler);
router.post('/:code/upload-url', rateLimiter('uploadUrl'), authenticateRoom, generateUploadUrlHandler);

export default router;

