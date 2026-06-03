import { Router } from 'express';
import {
  listSavedRoomsHandler,
  saveRoomHandler,
  unsaveRoomHandler,
  roomHistoryHandler,
  recoverRoomHandler,
  listOwnedRoomsHandler,
} from '../controllers/userController.js';
import { authenticateUser, requirePremium } from '../middleware/userAuth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

router.use(authenticateUser);

router.get('/rooms/saved', requirePremium, rateLimiter('default'), listSavedRoomsHandler);
router.get('/rooms/owned', requirePremium, rateLimiter('default'), listOwnedRoomsHandler);
router.post('/rooms/:code/save', requirePremium, rateLimiter('default'), saveRoomHandler);
router.delete('/rooms/:code/save', requirePremium, rateLimiter('default'), unsaveRoomHandler);
router.get('/rooms/:code/history', requirePremium, rateLimiter('default'), roomHistoryHandler);
router.post('/rooms/:code/recover', requirePremium, rateLimiter('default'), recoverRoomHandler);

export default router;
