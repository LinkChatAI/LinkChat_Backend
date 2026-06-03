import { Router } from 'express';
import {
  googleAuthHandler,
  googleCallbackHandler,
  getMeHandler,
  refreshHandler,
  logoutHandler,
  linkGuestHandler,
  authStatusHandler,
} from '../controllers/authController.js';
import {
  authenticateUser,
  optionalAuthenticateUser,
} from '../middleware/userAuth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

router.get('/status', authStatusHandler);
router.get('/google', rateLimiter('authOAuth'), googleAuthHandler);
router.get('/google/callback', rateLimiter('authOAuth'), googleCallbackHandler);
router.get('/me', optionalAuthenticateUser, getMeHandler);
router.post('/refresh', rateLimiter('authRefresh'), refreshHandler);
router.post('/logout', optionalAuthenticateUser, logoutHandler);
router.post('/link-guest', authenticateUser, rateLimiter('default'), linkGuestHandler);

export default router;
