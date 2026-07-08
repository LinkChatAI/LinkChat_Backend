import { Router } from 'express';
import {
  getMySubscriptionsHandler,
  createPurchaseRequestHandler,
} from '../controllers/subscriptionController.js';
import { authenticateUser } from '../middleware/userAuth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Purchasing/viewing subscriptions requires being logged in.
router.use(authenticateUser);

router.get('/me', rateLimiter('default'), getMySubscriptionsHandler);
router.post('/purchase-request', rateLimiter('default'), createPurchaseRequestHandler);

export default router;
