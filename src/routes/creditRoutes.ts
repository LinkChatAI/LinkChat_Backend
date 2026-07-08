import { Router } from 'express';
import { getMyCreditsHandler } from '../controllers/creditController.js';
import { authenticateUser } from '../middleware/userAuth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

router.use(authenticateUser);

router.get('/me', rateLimiter('default'), getMyCreditsHandler);

export default router;
