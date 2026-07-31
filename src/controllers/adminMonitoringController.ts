import { Response } from 'express';
import { z } from 'zod';
import { AdminRequest } from '../middleware/adminAuth.js';
import { logger, getRecentLogs } from '../utils/logger.js';
import { getMetricsSummaryJson } from '../services/metricsService.js';
import { getJobsHealth } from '../services/jobHealthService.js';
import {
  getLatestSnapshot,
  getHistory,
  getAlerts,
  getSecurityEvents,
  getStorageUsage,
  getEnvironmentInfo,
  getCloudServicesHealth,
  getDiskUsage,
} from '../services/serverMonitoringService.js';

/** Admin server-monitoring endpoints. All routes sit behind authenticateAdmin + rate limiting + audit (see adminMonitoringRoutes.ts). */

const RANGE_TO_HOURS: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24, '48h': 48 };

const HistoryQuerySchema = z.object({
  range: z.enum(['1h', '6h', '24h', '48h']).default('6h'),
});

const LogsQuerySchema = z.object({
  level: z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG']).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const LimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** GET /overview — headline health/version/performance snapshot for the panel's landing sub-tab. */
export const monitoringOverviewHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const snapshot = getLatestSnapshot();
    const disk = await getDiskUsage();
    const metrics = getMetricsSummaryJson();
    const [jobs, alerts] = await Promise.all([getJobsHealth(), getAlerts(50)]);

    res.json({
      warmingUp: !snapshot,
      snapshot,
      disk,
      environment: getEnvironmentInfo(),
      cloudHealth: getCloudServicesHealth(),
      cache: metrics.adminCache,
      jobs,
      alertsUnresolvedCount: alerts.filter((a) => a.severity !== 'resolved').length,
      uptimeSec: Math.round(process.uptime()),
    });
  } catch (error: any) {
    logger.error('Monitoring overview failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load monitoring overview' });
  }
};

/** GET /history?range=1h|6h|24h|48h — chronological metric snapshots for trend charts. */
export const monitoringHistoryHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters' });
      return;
    }
    const rangeHours = RANGE_TO_HOURS[parsed.data.range];
    const samples = await getHistory(rangeHours);
    res.json({ range: parsed.data.range, samples });
  } catch (error: any) {
    logger.error('Monitoring history failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load monitoring history' });
  }
};

/** GET /logs?level=&search=&limit= — this instance's in-memory log ring buffer. */
export const monitoringLogsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = LogsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters' });
      return;
    }
    const { level, search, limit } = parsed.data;
    const logs = getRecentLogs({ level, search, limit });
    res.json({ logs, instanceRevision: process.env.K_REVISION || null, capacityPerInstance: 1000 });
  } catch (error: any) {
    logger.error('Monitoring logs failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load logs' });
  }
};

/** GET /security-events?limit= — recent failed-admin-auth attempts + rolling 10-min count. */
export const monitoringSecurityEventsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = LimitQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters' });
      return;
    }
    const result = await getSecurityEvents(parsed.data.limit);
    res.json(result);
  } catch (error: any) {
    logger.error('Monitoring security events failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load security events' });
  }
};

/** GET /jobs — last-run status for cleanup/auto-vanish/subscription-expiry/orphaned-uploads/reconcile-orphans. */
export const monitoringJobsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const jobs = await getJobsHealth();
    res.json({ jobs });
  } catch (error: any) {
    logger.error('Monitoring jobs failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load background job health' });
  }
};

/** GET /storage — GCS reachability (reuses gcsService's cached probe) + today's upload counters. */
export const monitoringStorageHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const storage = await getStorageUsage();
    const metrics = getMetricsSummaryJson();
    res.json({ ...storage, bandwidth: { bytesInTotal: metrics.bytesInTotal, bytesOutTotal: metrics.bytesOutTotal } });
  } catch (error: any) {
    logger.error('Monitoring storage failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load storage usage' });
  }
};

/** GET /alerts?limit= — recent threshold-crossing alerts (edge-triggered, newest first). */
export const monitoringAlertsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = LimitQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters' });
      return;
    }
    const alerts = await getAlerts(parsed.data.limit);
    res.json({ alerts });
  } catch (error: any) {
    logger.error('Monitoring alerts failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to load alerts' });
  }
};
