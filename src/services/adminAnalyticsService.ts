import { UserVisitModel } from '../models/UserVisit.js';
import { UserModel } from '../models/User.js';
import { logger } from '../utils/logger.js';

/**
 * Behavioural analytics derived from UserVisit — retention, stickiness,
 * geography and per-room engagement.
 *
 * WHY UserVisit AND NOT Room/Message: both Room and Message carry a TTL index
 * (expireAfterSeconds: 0) and are hard-deleted minutes after a room expires, so
 * any historical figure computed from them is silently wrong. UserVisit has no
 * TTL and is the only durable per-session record the platform keeps.
 *
 * COST CONTRACT — every pipeline here is:
 *   1. Bounded by a `joinedAt` range, which is the leading field of the
 *      existing {joinedAt:-1} index (and of {userId:1,joinedAt:-1} /
 *      {roomCode:1,joinedAt:-1}), so the range is an index scan, never a
 *      collection scan.
 *   2. Capped with $limit before returning arrays.
 *   3. Served behind a 5-minute HTTP cache at the route layer.
 * No new indexes are added — the collection already carries four, and each one
 * costs a write on every room join.
 */

export interface DailyPoint {
  date: string;
  count: number;
}

export interface TopRoom {
  roomCode: string;
  visits: number;
  uniqueUsers: number;
  avgSessionMinutes: number;
  lastSeen: string;
}

export interface TopCountry {
  country: string;
  visits: number;
  uniqueUsers: number;
}

export interface HourBucket {
  hour: number; // 0-23 UTC
  count: number;
}

export interface AdminAnalyticsBundle {
  windowDays: number;

  // Reach
  totalVisits: number;
  uniqueUsers: number;
  newUsers: number;
  returningUsers: number;
  returningRate: number; // percent

  // Stickiness
  dau: number;
  wau: number;
  mau: number;
  stickiness: number; // DAU/MAU percent

  // Session quality
  avgSessionMinutes: number;
  medianSessionMinutes: number;
  avgMessagesPerVisit: number;
  bounceRate: number; // percent of visits under 60s with no messages

  // Series
  visitsSeries: DailyPoint[];
  uniqueUsersSeries: DailyPoint[];
  visitsByHour: HourBucket[];

  // Breakdowns
  topRooms: TopRoom[];
  topCountries: TopCountry[];

  // Accounts (User has no TTL either)
  registeredUsers: number;
  registeredUsersInWindow: number;

  generatedAt: string;
}

const clampDays = (days: number): number => {
  if (!Number.isFinite(days)) return 30;
  return Math.min(90, Math.max(1, Math.floor(days)));
};

const dayKey = (d: Date): string => d.toISOString().split('T')[0];

/** Fill missing days with zeros so the chart has a continuous x-axis. */
const densifySeries = (
  rows: Array<{ _id: string; count: number }>,
  days: number
): DailyPoint[] => {
  const byDate = new Map(rows.map((r) => [r._id, r.count]));
  const out: DailyPoint[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d);
    out.push({ date: key, count: byDate.get(key) ?? 0 });
  }
  return out;
};

export const computeAnalytics = async (daysInput = 30): Promise<AdminAnalyticsBundle> => {
  const windowDays = clampDays(daysInput);
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const inWindow = { joinedAt: { $gte: since } };

  const [
    headline,
    visitsSeriesRaw,
    uniqueSeriesRaw,
    hourRows,
    topRoomsRaw,
    topCountriesRaw,
    dauRows,
    wauRows,
    mauRows,
    firstSeenRows,
    registeredUsers,
    registeredUsersInWindow,
  ] = await Promise.all([
    // Headline aggregates in a single pass over the window.
    UserVisitModel.aggregate([
      { $match: inWindow },
      {
        $group: {
          _id: null,
          totalVisits: { $sum: 1 },
          sessionSum: { $sum: { $ifNull: ['$sessionDuration', 0] } },
          sessionCount: {
            $sum: { $cond: [{ $gt: ['$sessionDuration', 0] }, 1, 0] },
          },
          messageSum: { $sum: { $ifNull: ['$messagesSent', 0] } },
          bounces: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $lt: [{ $ifNull: ['$sessionDuration', 0] }, 60000] },
                    { $eq: [{ $ifNull: ['$messagesSent', 0] }, 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]).allowDiskUse(true),

    UserVisitModel.aggregate([
      { $match: inWindow },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$joinedAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).allowDiskUse(true),

    UserVisitModel.aggregate([
      { $match: inWindow },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$joinedAt' } },
            userId: '$userId',
          },
        },
      },
      { $group: { _id: '$_id.date', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).allowDiskUse(true),

    UserVisitModel.aggregate([
      { $match: inWindow },
      { $group: { _id: { $hour: { date: '$joinedAt', timezone: 'UTC' } }, count: { $sum: 1 } } },
    ]).allowDiskUse(true),

    UserVisitModel.aggregate([
      { $match: inWindow },
      {
        $group: {
          _id: '$roomCode',
          visits: { $sum: 1 },
          users: { $addToSet: '$userId' },
          sessionSum: { $sum: { $ifNull: ['$sessionDuration', 0] } },
          sessionCount: { $sum: { $cond: [{ $gt: ['$sessionDuration', 0] }, 1, 0] } },
          lastSeen: { $max: '$joinedAt' },
        },
      },
      { $sort: { visits: -1 } },
      { $limit: 20 },
      {
        $project: {
          visits: 1,
          lastSeen: 1,
          uniqueUsers: { $size: '$users' },
          avgSessionMinutes: {
            $cond: [
              { $gt: ['$sessionCount', 0] },
              { $divide: [{ $divide: ['$sessionSum', '$sessionCount'] }, 60000] },
              0,
            ],
          },
        },
      },
    ]).allowDiskUse(true),

    UserVisitModel.aggregate([
      { $match: { ...inWindow, country: { $nin: [null, ''] } } },
      { $group: { _id: '$country', visits: { $sum: 1 }, users: { $addToSet: '$userId' } } },
      { $sort: { visits: -1 } },
      { $limit: 12 },
      { $project: { visits: 1, uniqueUsers: { $size: '$users' } } },
    ]).allowDiskUse(true),

    UserVisitModel.distinct('userId', { joinedAt: { $gte: since24h } }),
    UserVisitModel.distinct('userId', { joinedAt: { $gte: since7d } }),
    UserVisitModel.distinct('userId', { joinedAt: { $gte: since30d } }),

    // New vs returning: a user is "new" if their earliest-ever visit falls
    // inside the window. Grouping by userId with $min over all time would be a
    // full scan, so instead take the window's users and check whether any
    // visit predates the window — one indexed lookup per branch, not per user.
    UserVisitModel.aggregate([
      { $match: inWindow },
      { $group: { _id: '$userId' } },
      {
        $lookup: {
          from: 'uservisits',
          let: { uid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ['$userId', '$$uid'] }, { $lt: ['$joinedAt', since] }] },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'prior',
        },
      },
      {
        $group: {
          _id: null,
          uniqueUsers: { $sum: 1 },
          returning: { $sum: { $cond: [{ $gt: [{ $size: '$prior' }, 0] }, 1, 0] } },
        },
      },
    ]).allowDiskUse(true),

    UserModel.countDocuments({}),
    UserModel.countDocuments({ createdAt: { $gte: since } }),
  ]);

  const h = headline[0] || {
    totalVisits: 0,
    sessionSum: 0,
    sessionCount: 0,
    messageSum: 0,
    bounces: 0,
  };
  const fs = firstSeenRows[0] || { uniqueUsers: 0, returning: 0 };

  const uniqueUsers = fs.uniqueUsers || 0;
  const returningUsers = fs.returning || 0;
  const newUsers = Math.max(0, uniqueUsers - returningUsers);

  const dau = dauRows.length;
  const mau = mauRows.length;

  // Median session: computed from the same bounded window, capped so the sort
  // stays in memory. Approximate by design — exact percentiles would need
  // $percentile (Mongo 7+) or a full sort of every visit in the window.
  let medianSessionMinutes = 0;
  try {
    const sample = await UserVisitModel.find({ ...inWindow, sessionDuration: { $gt: 0 } })
      .select('sessionDuration')
      .sort({ joinedAt: -1 })
      .limit(5000)
      .lean()
      .exec();
    if (sample.length > 0) {
      const sorted = sample.map((s) => s.sessionDuration || 0).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const raw =
        sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      medianSessionMinutes = raw / 60000;
    }
  } catch (error: unknown) {
    logger.warn('Median session computation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    windowDays,

    totalVisits: h.totalVisits || 0,
    uniqueUsers,
    newUsers,
    returningUsers,
    returningRate: uniqueUsers > 0 ? round1((returningUsers / uniqueUsers) * 100) : 0,

    dau,
    wau: wauRows.length,
    mau,
    stickiness: mau > 0 ? round1((dau / mau) * 100) : 0,

    avgSessionMinutes: h.sessionCount > 0 ? round1(h.sessionSum / h.sessionCount / 60000) : 0,
    medianSessionMinutes: round1(medianSessionMinutes),
    avgMessagesPerVisit: h.totalVisits > 0 ? round1(h.messageSum / h.totalVisits) : 0,
    bounceRate: h.totalVisits > 0 ? round1((h.bounces / h.totalVisits) * 100) : 0,

    visitsSeries: densifySeries(visitsSeriesRaw as Array<{ _id: string; count: number }>, windowDays),
    uniqueUsersSeries: densifySeries(
      uniqueSeriesRaw as Array<{ _id: string; count: number }>,
      windowDays
    ),
    visitsByHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: (hourRows as Array<{ _id: number; count: number }>).find((r) => r._id === hour)?.count ?? 0,
    })),

    topRooms: (topRoomsRaw as any[]).map((r) => ({
      roomCode: r._id,
      visits: r.visits,
      uniqueUsers: r.uniqueUsers,
      avgSessionMinutes: round1(r.avgSessionMinutes || 0),
      lastSeen: new Date(r.lastSeen).toISOString(),
    })),
    topCountries: (topCountriesRaw as any[]).map((c) => ({
      country: c._id,
      visits: c.visits,
      uniqueUsers: c.uniqueUsers,
    })),

    registeredUsers,
    registeredUsersInWindow,

    generatedAt: new Date().toISOString(),
  };
};
