import { Router } from 'express';
import { generateNicknameHandler } from '../controllers/nicknameController.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

router.get('/', rateLimiter('default'), generateNicknameHandler);

export default router;
