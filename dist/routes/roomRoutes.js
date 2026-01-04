import { Router } from 'express';
import { createRoomHandler, getRoomHandler, generateUploadUrlHandler, generatePairingCodeHandler, validatePairingCodeHandler, uploadLocalFileHandler, endRoomHandler, leaveRoomHandler, } from '../controllers/roomController.js';
import { getShareMetaHandler } from '../controllers/seoController.js';
import { authenticateRoom } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
const router = Router();
router.post('/', rateLimiter('createRoom'), createRoomHandler);
router.get('/:slugOrCode', rateLimiter('getRoom'), getRoomHandler);
router.get('/:slugOrCode/sharemeta', rateLimiter('getRoom'), getShareMetaHandler);
router.post('/:code/upload-url', rateLimiter('uploadUrl'), authenticateRoom, generateUploadUrlHandler);
router.post('/:code/upload-local', rateLimiter('uploadUrl'), authenticateRoom, uploadLocalFileHandler);
router.post('/:code/pairing/generate', rateLimiter('default'), generatePairingCodeHandler);
router.post('/pairing/validate', rateLimiter('default'), validatePairingCodeHandler);
router.post('/:code/end', rateLimiter('default'), authenticateRoom, endRoomHandler);
router.post('/:code/leave', rateLimiter('default'), leaveRoomHandler);
export default router;
//# sourceMappingURL=roomRoutes.js.map