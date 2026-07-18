import { Response } from 'express';
import mongoose from 'mongoose';
import { AdminRequest } from '../middleware/adminAuth.js';
import { computeAnalytics } from '../services/adminAnalyticsService.js';
import { getAuditLog, getAuditSummary, getAuditActionNames } from '../services/adminAuditService.js';
import { logger } from '../utils/logger.js';

/** GET /admin/analytics?days=30 — behavioural analytics derived from UserVisit. */
export const getAnalytics = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    const days = parseInt(String(req.query.days || '30'), 10);
    const analytics = await computeAnalytics(days);
    res.json({ analytics });
  } catch (error: unknown) {
    logger.error('Error computing analytics', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
};

/** GET /admin/audit/log — paginated audit trail with filters. */
export const getAuditLogHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    const successParam = req.query.success;
    const result = await getAuditLog({
      page: parseInt(String(req.query.page || '1'), 10),
      limit: parseInt(String(req.query.limit || '50'), 10),
      action: req.query.action ? String(req.query.action) : undefined,
      adminId: req.query.adminId ? String(req.query.adminId) : undefined,
      success:
        successParam === undefined || successParam === '' || successParam === 'all'
          ? undefined
          : String(successParam) === 'true',
      days: parseInt(String(req.query.days || '7'), 10),
    });
    res.json(result);
  } catch (error: unknown) {
    logger.error('Error fetching audit log', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
};

/** GET /admin/audit/summary — rollup of admin activity for the window. */
export const getAuditSummaryHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    const days = parseInt(String(req.query.days || '7'), 10);
    const [summary, actions] = await Promise.all([
      getAuditSummary(days),
      getAuditActionNames(days),
    ]);
    res.json({ summary, actions });
  } catch (error: unknown) {
    logger.error('Error fetching audit summary', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to fetch audit summary' });
  }
};
