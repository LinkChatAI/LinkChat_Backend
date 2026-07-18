import { Router } from 'express';
import {
  googleAuthHandler,
  googleCallbackHandler,
  getMeHandler,
  refreshHandler,
  logoutHandler,
  linkGuestHandler,
  authStatusHandler,
  createSessionExchangeHandler,
  consumeSessionExchangeHandler,
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

// Cross-domain session bridge (linkchat.in <-> the backend's own domain) —
// see sessionExchangeService.ts for why this exists.
router.post('/session-exchange/create', authenticateUser, rateLimiter('sessionExchange'), createSessionExchangeHandler);
router.get('/session-exchange/consume', rateLimiter('sessionExchange'), consumeSessionExchangeHandler);

export default router;
