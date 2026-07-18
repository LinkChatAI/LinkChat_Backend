import { AdminActionModel } from '../models/AdminAction.js';

/**
 * Query layer over the AdminAction audit trail.
 *
 * Every admin REST call has been writing a row here since the audit middleware
 * landed, but nothing ever read them back — there was no UI and no query API.
 * This exposes that existing data; it adds no new writes.
 *
 * COST CONTRACT — the collection already carries five compound indexes, all
 * with createdAt as the trailing sort field:
 *     {createdAt:-1} {adminId:1,createdAt:-1} {endpoint:1,createdAt:-1}
 *     {success:1,createdAt:-1} {action:1,createdAt:-1}
 * Filters below are deliberately restricted to that set so every query is
 * index-served with an indexed sort (no in-memory sort, no collection scan).
 * No new index is added.
 */

export interface AuditLogFilters {
  page?: number;
  limit?: number;
  action?: string;
  success?: boolean;
  adminId?: string;
  days?: number;
}

export interface AuditLogEntry {
  _id: string;
  adminId: string;
  adminEmail?: string;
  action: string;
  endpoint: string;
  method: string;
  ipAddress: string;
  success: boolean;
  errorMessage?: string;
  responseTime?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export interface AuditSummary {
  windowDays: number;
  totalActions: number;
  failedActions: number;
  failureRate: number; // percent
  avgResponseTime: number; // ms
  uniqueAdmins: number;
  byAction: Array<{ action: string; count: number; failed: number }>;
  recentFailures: AuditLogEntry[];
}

const clampDays = (days?: number): number => {
  const d = Number(days);
  if (!Number.isFinite(d)) return 7;
  return Math.min(90, Math.max(1, Math.floor(d)));
};

const buildMatch = (filters: AuditLogFilters) => {
  const since = new Date(Date.now() - clampDays(filters.days) * 24 * 60 * 60 * 1000);
  const match: Record<string, unknown> = { createdAt: { $gte: since } };
  if (filters.action) match.action = filters.action;
  if (typeof filters.success === 'boolean') match.success = filters.success;
  if (filters.adminId) match.adminId = filters.adminId;
  return match;
};

const toEntry = (doc: any): AuditLogEntry => ({
  _id: String(doc._id),
  adminId: doc.adminId,
  adminEmail: doc.adminEmail,
  action: doc.action,
  endpoint: doc.endpoint,
  method: doc.method,
  ipAddress: doc.ipAddress,
  success: !!doc.success,
  errorMessage: doc.errorMessage,
  responseTime: doc.responseTime,
  metadata: doc.metadata,
  createdAt: new Date(doc.createdAt).toISOString(),
});

export const getAuditLog = async (filters: AuditLogFilters = {}): Promise<AuditLogPage> => {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(filters.limit) || 50)));
  const match = buildMatch(filters);

  const [docs, total] = await Promise.all([
    AdminActionModel.find(match)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec(),
    AdminActionModel.countDocuments(match),
  ]);

  return {
    entries: docs.map(toEntry),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  };
};

export const getAuditSummary = async (daysInput?: number): Promise<AuditSummary> => {
  const windowDays = clampDays(daysInput);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const match = { createdAt: { $gte: since } };

  const [headline, byAction, admins, failures] = await Promise.all([
    AdminActionModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalActions: { $sum: 1 },
          failedActions: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
          responseSum: { $sum: { $ifNull: ['$responseTime', 0] } },
          responseCount: { $sum: { $cond: [{ $gt: ['$responseTime', 0] }, 1, 0] } },
        },
      },
    ]).allowDiskUse(true),

    AdminActionModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
          failed: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 25 },
    ]).allowDiskUse(true),

    AdminActionModel.distinct('adminId', match),

    AdminActionModel.find({ ...match, success: false })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean()
      .exec(),
  ]);

  const h = headline[0] || { totalActions: 0, failedActions: 0, responseSum: 0, responseCount: 0 };

  return {
    windowDays,
    totalActions: h.totalActions,
    failedActions: h.failedActions,
    failureRate:
      h.totalActions > 0 ? Math.round((h.failedActions / h.totalActions) * 1000) / 10 : 0,
    avgResponseTime: h.responseCount > 0 ? Math.round(h.responseSum / h.responseCount) : 0,
    uniqueAdmins: admins.length,
    byAction: (byAction as any[]).map((a) => ({
      action: a._id,
      count: a.count,
      failed: a.failed,
    })),
    recentFailures: failures.map(toEntry),
  };
};

/** Distinct action names in the window — populates the filter dropdown. */
export const getAuditActionNames = async (daysInput?: number): Promise<string[]> => {
  const since = new Date(Date.now() - clampDays(daysInput) * 24 * 60 * 60 * 1000);
  const names = await AdminActionModel.distinct('action', { createdAt: { $gte: since } });
  return (names as string[]).sort();
};
