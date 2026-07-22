import { Router } from 'express';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  getDonationConfigHandler,
  createDonationOrderHandler,
  verifyDonationHandler,
  reportDonationFailureHandler,
  donationWebhookHandler,
  getDonationReceiptHandler,
} from '../controllers/donationController.js';

const router = Router();

// Public config for the donation popup
router.get('/config', getDonationConfigHandler);

// Order creation is the abuse surface (each call hits the Razorpay API) — keep it tight.
router.post('/create-order', rateLimiter('donationOrder'), createDonationOrderHandler);

// Checkout result callbacks
router.post('/verify', rateLimiter('donationVerify'), verifyDonationHandler);
router.post('/payment-failed', rateLimiter('donationVerify'), reportDonationFailureHandler);

// Razorpay server-to-server webhook (authenticated by HMAC signature, not by IP
// or session — deliberately NOT rate-limited so legitimate retries always land).
router.post('/webhook', donationWebhookHandler);

// Public receipt lookup (thank-you screen)
router.get('/receipt/:receiptNumber', rateLimiter('donationVerify'), getDonationReceiptHandler);

export default router;
