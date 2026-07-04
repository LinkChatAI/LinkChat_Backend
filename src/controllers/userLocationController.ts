import { Request, Response } from 'express';
import { UserVisitModel } from '../models/UserVisit.js';
import { logger } from '../utils/logger.js';

const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;

/**
 * GET /api/admin/user-locations
 * Aggregates UserVisit records (already enriched with approximate, IP-derived
 * city/region/country) into per-location clusters for the admin map view.
 * Optional query params: days (lookback window), roomCode (scope to one room).
 */
export const getUserLocations = async (req: Request, res: Response): Promise<void> => {
  try {
    const daysParam = parseInt(req.query.days as string, 10);
    const days = Number.isFinite(daysParam) && daysParam > 0
      ? Math.min(daysParam, MAX_WINDOW_DAYS)
      : DEFAULT_WINDOW_DAYS;
    const roomCode = typeof req.query.roomCode === 'string' ? req.query.roomCode.trim() : undefined;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const match: Record<string, unknown> = {
      joinedAt: { $gte: since },
      country: { $exists: true, $ne: null },
      lat: { $exists: true, $ne: null },
      lon: { $exists: true, $ne: null },
    };
    if (roomCode) {
      match.roomCode = roomCode;
    }

    const [clusters, totals] = await Promise.all([
      UserVisitModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: { country: '$country', region: '$region', city: '$city' },
            lat: { $avg: '$lat' },
            lon: { $avg: '$lon' },
            visitCount: { $sum: 1 },
            userIds: { $addToSet: '$userId' },
            lastSeen: { $max: '$joinedAt' },
          },
        },
        {
          $project: {
            _id: 0,
            country: '$_id.country',
            region: '$_id.region',
            city: '$_id.city',
            lat: 1,
            lon: 1,
            visitCount: 1,
            uniqueUsers: { $size: '$userIds' },
            lastSeen: 1,
          },
        },
        { $sort: { visitCount: -1 } },
        { $limit: 500 },
      ]).allowDiskUse(true),
      UserVisitModel.aggregate([
        { $match: { joinedAt: { $gte: since }, ...(roomCode ? { roomCode } : {}) } },
        {
          $group: {
            _id: null,
            totalVisits: { $sum: 1 },
            geolocatedVisits: {
              $sum: { $cond: [{ $ifNull: ['$country', false] }, 1, 0] },
            },
          },
        },
      ]).allowDiskUse(true),
    ]);

    res.json({
      clusters,
      totalVisits: totals[0]?.totalVisits || 0,
      geolocatedVisits: totals[0]?.geolocatedVisits || 0,
      windowDays: days,
    });
  } catch (error: unknown) {
    logger.error('Error fetching user locations', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch user locations' });
  }
};
