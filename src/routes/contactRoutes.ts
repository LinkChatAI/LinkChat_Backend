import { Router } from 'express';
import { submitContact, submitSalesInquiry } from '../controllers/contactController.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Public route: Submit contact form
// Rate limit: 5 submissions per hour per IP
router.post(
  '/submit',
  rateLimiter('contactSubmit'),
  submitContact
);

router.post(
  '/sales-inquiry',
  rateLimiter('contactSubmit'),
  submitSalesInquiry
);

export default router;

