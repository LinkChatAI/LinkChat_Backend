import { Router } from 'express';
import { authenticateAdmin } from '../middleware/adminAuth.js';
import { auditAdminAction } from '../middleware/adminAudit.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  listDonationsHandler,
  donationStatsHandler,
  getDonationHandler,
  refundDonationHandler,
  syncDonationHandler,
  setDonationNoteHandler,
  getDonationSettingsHandler,
  updateDonationSettingsHandler,
  exportDonationsCsvHandler,
} from '../controllers/adminDonationController.js';

/**
 * Donation management for the ops dashboard. Uses the same shared-secret gate
 * (X-Admin-Secret) as the rest of the admin panel. Mounted OUTSIDE /api/admin
 * for the same reason as adminBillingRoutes — that prefix is fully claimed by
 * the legacy adminRoutes router.
 */
const router = Router();

router.use(authenticateAdmin);

// Reads (dashboard-refresh cadence)
router.get('/stats', rateLimiter('adminDashboard'), auditAdminAction('DONATIONS_STATS_VIEW'), donationStatsHandler);
router.get('/list', rateLimiter('adminDashboard'), auditAdminAction('DONATIONS_LIST_VIEW'), listDonationsHandler);
router.get('/settings', rateLimiter('adminDashboard'), auditAdminAction('DONATIONS_SETTINGS_VIEW'), getDonationSettingsHandler);
router.get('/export.csv', rateLimiter('adminAction'), auditAdminAction('DONATIONS_EXPORT_CSV'), exportDonationsCsvHandler);
router.get('/:id', rateLimiter('adminDashboard'), auditAdminAction('DONATION_DETAIL_VIEW'), getDonationHandler);

// Mutations (tight limit)
router.put('/settings', rateLimiter('adminAction'), auditAdminAction('DONATIONS_SETTINGS_UPDATE'), updateDonationSettingsHandler);
router.post('/:id/refund', rateLimiter('adminAction'), auditAdminAction('DONATION_REFUND'), refundDonationHandler);
router.post('/:id/sync', rateLimiter('adminAction'), auditAdminAction('DONATION_SYNC'), syncDonationHandler);
router.post('/:id/note', rateLimiter('adminAction'), auditAdminAction('DONATION_NOTE_SET'), setDonationNoteHandler);

export default router;
