import { Router } from 'express';
import { listActivePlansHandler } from '../controllers/planController.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Public — the pricing page needs this without a login.
router.get('/', rateLimiter('default'), listActivePlansHandler);

export default router;
