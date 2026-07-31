import { Router } from 'express';
import { authenticateAdmin } from '../middleware/adminAuth.js';
import { auditAdminAction } from '../middleware/adminAudit.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  monitoringOverviewHandler,
  monitoringHistoryHandler,
  monitoringLogsHandler,
  monitoringSecurityEventsHandler,
  monitoringJobsHandler,
  monitoringStorageHandler,
  monitoringAlertsHandler,
} from '../controllers/adminMonitoringController.js';

/**
 * Server Monitoring dashboard for the ops panel. Same shared-secret gate
 * (X-Admin-Secret) as the rest of admin — see adminDonationRoutes.ts. Mounted
 * OUTSIDE /api/admin for the same reason as donations/billing: that prefix is
 * fully claimed by the legacy adminRoutes router's `.use(authenticateAdmin)`.
 *
 * `requireAdminRole` (adminRoleAuth.ts) could replace authenticateAdmin below
 * later, with no controller changes, if monitoring ever needs to be
 * restricted to a subset of admins rather than anyone holding the shared
 * secret.
 */
const router = Router();

router.use(authenticateAdmin);

router.get(
  '/overview',
  rateLimiter('adminMonitoring'),
  auditAdminAction('MONITORING_OVERVIEW_VIEW'),
  monitoringOverviewHandler
);
router.get(
  '/history',
  rateLimiter('adminMonitoring'),
  auditAdminAction('MONITORING_HISTORY_VIEW'),
  monitoringHistoryHandler
);
router.get('/logs', rateLimiter('adminMonitoring'), auditAdminAction('MONITORING_LOGS_VIEW'), monitoringLogsHandler);
router.get(
  '/security-events',
  rateLimiter('adminMonitoring'),
  auditAdminAction('MONITORING_SECURITY_EVENTS_VIEW'),
  monitoringSecurityEventsHandler
);
router.get('/jobs', rateLimiter('adminMonitoring'), auditAdminAction('MONITORING_JOBS_VIEW'), monitoringJobsHandler);
router.get(
  '/storage',
  rateLimiter('adminMonitoring'),
  auditAdminAction('MONITORING_STORAGE_VIEW'),
  monitoringStorageHandler
);
router.get(
  '/alerts',
  rateLimiter('adminMonitoring'),
  auditAdminAction('MONITORING_ALERTS_VIEW'),
  monitoringAlertsHandler
);

export default router;
