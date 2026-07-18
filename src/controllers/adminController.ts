import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { UserVisitModel } from '../models/UserVisit.js';
import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { AdminRequest } from '../middleware/adminAuth.js';
import { invalidateDashboardCache } from '../middleware/adminCache.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { adminVanishRoom } from '../services/adminRoomService.js';
import { getOrCreateGlobalStat, getSelfHealingGlobalStat } from '../utils/globalStats.js';
import { getDashboardInsightsCached } from '../services/adminInsightsService.js';
import { getLiveUserCountsForRooms } from '../services/roomPresenceService.js';

/**
 * Get start of day in server timezone (not UTC)
 */
const getStartOfDay = (): Date => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  return startOfDay;
};

export const getTotalRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    // Room documents are TTL-deleted shortly after expiry (Room.ts's
    // expireAfterSeconds index), so a live count only ever reflects rooms
    // that haven't been reaped yet — not a true lifetime total. Durable
    // counter, self-healed from the current live count on first read.
    const count = await getSelfHealingGlobalStat('totalRoomsLifetime', () => RoomModel.estimatedDocumentCount());
    res.json({ totalRooms: count });
  } catch (error: any) {
    logger.error('Error getting total rooms', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get total rooms' });
  }
};

export const getActiveRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const count = await RoomModel.countDocuments({
      isEnded: { $ne: true },
      isLocked: { $ne: true },
      expiresAt: { $gt: now }
    });
    res.json({ activeRooms: count });
  } catch (error: any) {
    logger.error('Error getting active rooms', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get active rooms' });
  }
};

export const getLockedRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const count = await RoomModel.countDocuments({
      isLocked: true,
      isEnded: { $ne: true }
    });
    res.json({ lockedRooms: count });
  } catch (error: any) {
    logger.error('Error getting locked rooms', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get locked rooms' });
  }
};

export const getAutoVanishRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const count = await RoomModel.countDocuments({
      isLocked: true,
      lockedAt: {
        $exists: true,
        $gte: oneDayAgo,
        $lte: now
      },
      isEnded: { $ne: true },
      expiresAt: { $gt: now }
    });
    res.json({ autoVanishRooms: count });
  } catch (error: any) {
    logger.error('Error getting auto-vanish rooms', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get auto-vanish rooms' });
  }
};

export const getVanishedToday = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setHours(23, 59, 59, 999);

    const result = await RoomModel.aggregate([
      {
        $match: {
          $or: [
            { isEnded: true, endedAt: { $gte: startOfDay, $lte: endOfDay } },
            { expiresAt: { $gte: startOfDay, $lte: endOfDay } }
          ]
        }
      },
      {
        $count: 'count'
      }
    ]);

    const count = result[0]?.count || 0;
    res.json({ vanishedToday: count });
  } catch (error: any) {
    logger.error('Error getting vanished today', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get vanished today' });
  }
};

export const getUsersOnline = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const redis = getRedisClient();

    if (!redis || !isRedisAvailable()) {
      res.json({
        usersOnline: 0,
        note: 'Redis not available. Online user count requires Redis for real-time tracking.'
      });
      return;
    }

    // Non-blocking cursor scan (KEYS blocks Redis's single-threaded event
    // loop for every other caller — including the join/leave hot path —
    // for the duration of the scan) + a pipelined SMEMBERS batch instead of
    // one round trip per room. Same unique-user-dedup semantics as before.
    const keys: string[] = [];
    const stream = redis.scanStream({ match: 'room:*:users', count: 100 });
    for await (const chunk of stream as AsyncIterable<string[]>) {
      keys.push(...chunk);
    }

    const userIds = new Set<string>();
    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      keys.forEach((key: string) => pipeline.smembers(key));
      const results = await pipeline.exec();
      results?.forEach((result: [Error | null, unknown]) => {
        const [, members] = result;
        (members as string[] | undefined)?.forEach((userId: string) => userIds.add(userId));
      });
    }

    res.json({ usersOnline: userIds.size });
  } catch (error: any) {
    logger.error('Error getting users online', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get users online' });
  }
};

export const getUsersInLockedRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    // Room.participants is never populated on join (only ever $pull'd on
    // leave) — was always ~0 here. Use live per-room counts instead.
    const lockedRooms = await RoomModel.find({
      isLocked: true,
      isEnded: { $ne: true }
    }).select('code').lean().exec();

    const counts = await getLiveUserCountsForRooms(getIoInstance(), lockedRooms.map((r: any) => r.code));
    const total = Array.from(counts.values()).reduce((sum, c) => sum + c, 0);

    res.json({ usersInLockedRooms: total });
  } catch (error: any) {
    logger.error('Error getting users in locked rooms', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get users in locked rooms' });
  }
};

export const getRoomsExpiringInNextHour = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    const count = await RoomModel.countDocuments({
      expiresAt: {
        $gte: now,
        $lte: oneHourFromNow
      },
      isEnded: { $ne: true }
    });

    res.json({ roomsExpiringInNextHour: count });
  } catch (error: any) {
    logger.error('Error getting rooms expiring in next hour', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get rooms expiring in next hour' });
  }
};

export const getRoomsExpiringToday = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const count = await RoomModel.countDocuments({
      expiresAt: {
        $gte: startOfDay,
        $lte: endOfDay
      },
      isEnded: { $ne: true }
    });

    res.json({ roomsExpiringToday: count });
  } catch (error: any) {
    logger.error('Error getting rooms expiring today', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get rooms expiring today' });
  }
};

/**
 * GET /insights/dashboard — thin wrapper around the shared computation in
 * adminInsightsService.ts, which is also used by the admin Socket.IO push
 * (adminHandlers.ts). Previously this ~950-line function and a near-full
 * duplicate in adminHandlers.ts computed the same bundle independently via
 * two separate caches; they drifted (see plan doc "Bug D"). See
 * adminInsightsService.ts for the actual query logic and every correctness
 * fix (Bugs A/B/E/F) applied there.
 */
export const getDashboardInsights = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (mongoose.connection.readyState !== 1) {
      logger.warn('Database not connected when getting dashboard insights');
      res.status(503).json({ error: 'Database not connected' });
      return;
    }

    const insights = await getDashboardInsightsCached();
    res.json(insights);
  } catch (error: any) {
    logger.error('Error getting dashboard insights', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to get dashboard insights' });
  }
};

/**
 * DEBUG ENDPOINT: Returns raw counts and queries for verification
 * Route: GET /api/admin/debug-stats
 */
export const getDebugStats = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }

    const now = new Date();
    const startOfDay = getStartOfDay();
    const endOfDay = new Date(startOfDay);
    endOfDay.setHours(23, 59, 59, 999);

    // Run all queries and return raw results with queries used
    const [
      totalRoomsEstimated,
      totalRoomsCount,
      activeRooms,
      lockedRooms,
      messagesSentToday,
      messagesSentTodayRaw,
      filesSharedToday,
      storageUsedToday,
      totalUniqueUsers,
      totalVisits,
      visitsToday,
      usersOnline
    ] = await Promise.all([
      RoomModel.estimatedDocumentCount().catch(() => null),
      RoomModel.countDocuments({}),
      RoomModel.countDocuments({ expiresAt: { $gt: now }, isEnded: { $ne: true }, isLocked: { $ne: true } }),
      RoomModel.countDocuments({ isLocked: true, isEnded: { $ne: true } }),
      MessageModel.countDocuments({ createdAt: { $gte: startOfDay, $lte: endOfDay }, deletedByAdmin: { $ne: true } }),
      MessageModel.find({ createdAt: { $gte: startOfDay, $lte: endOfDay }, deletedByAdmin: { $ne: true } }).countDocuments(),
      MessageModel.countDocuments({ type: 'file', createdAt: { $gte: startOfDay, $lte: endOfDay }, deletedByAdmin: { $ne: true } }),
      MessageModel.aggregate([
        { $match: { type: 'file', createdAt: { $gte: startOfDay, $lte: endOfDay }, deletedByAdmin: { $ne: true }, 'fileMeta.size': { $exists: true } } },
        { $group: { _id: null, totalSize: { $sum: '$fileMeta.size' } } }
      ]).allowDiskUse(true),
      UserVisitModel.aggregate([{ $group: { _id: '$userId' } }, { $count: 'count' }]).allowDiskUse(true).then(r => r[0]?.count || 0),
      getOrCreateGlobalStat('totalVisitsLifetime'),
      UserVisitModel.countDocuments({ joinedAt: { $gte: startOfDay, $lte: endOfDay } }),
      (() => {
        const io = getIoInstance();
        return io ? (io.engine?.clientsCount || io.sockets.sockets.size || 0) : 0;
      })()
    ]);

    res.json({
      timestamp: new Date().toISOString(),
      dateRange: {
        startOfDay: startOfDay.toISOString(),
        endOfDay: endOfDay.toISOString(),
        now: now.toISOString()
      },
      queries: {
        totalRooms: {
          estimated: totalRoomsEstimated,
          count: totalRoomsCount,
          query: 'RoomModel.estimatedDocumentCount() or RoomModel.countDocuments({})'
        },
        activeRooms: {
          count: activeRooms,
          query: 'RoomModel.countDocuments({ expiresAt: { $gt: now }, isEnded: { $ne: true }, isLocked: { $ne: true } })'
        },
        lockedRooms: {
          count: lockedRooms,
          query: 'RoomModel.countDocuments({ isLocked: true, isEnded: { $ne: true } })'
        },
        messagesSentToday: {
          count: messagesSentToday,
          countRaw: messagesSentTodayRaw,
          query: 'MessageModel.countDocuments({ createdAt: { $gte: startOfDay, $lte: endOfDay }, deletedByAdmin: { $ne: true } })'
        },
        filesSharedToday: {
          count: filesSharedToday,
          query: 'MessageModel.countDocuments({ type: "file", createdAt: { $gte: startOfDay, $lte: endOfDay }, deletedByAdmin: { $ne: true } })'
        },
        storageUsedToday: {
          bytes: storageUsedToday[0]?.totalSize || 0,
          mb: storageUsedToday[0]?.totalSize ? (storageUsedToday[0].totalSize / (1024 * 1024)).toFixed(2) : '0.00',
          query: 'MessageModel.aggregate([{ $match: { type: "file", createdAt: { $gte: startOfDay }, "fileMeta.size": { $exists: true } } }, { $group: { _id: null, totalSize: { $sum: "$fileMeta.size" } } }])'
        },
        totalUniqueUsers: {
          count: totalUniqueUsers,
          query: 'UserVisitModel.aggregate([{ $group: { _id: "$userId" } }, { $count: "count" }])'
        },
        totalVisits: {
          count: totalVisits,
          query: 'GlobalStatsModel.findOne({ key: "totalVisitsLifetime" }) or UserVisitModel.countDocuments({})'
        },
        visitsToday: {
          count: visitsToday,
          query: 'UserVisitModel.countDocuments({ joinedAt: { $gte: startOfDay, $lte: endOfDay } })'
        },
        usersOnline: {
          count: usersOnline,
          query: 'io.engine.clientsCount or io.sockets.sockets.size'
        }
      },
      database: {
        connectionState: mongoose.connection.readyState,
        dbName: mongoose.connection.db?.databaseName
      }
    });
  } catch (error: any) {
    logger.error('Error getting debug stats', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to get debug stats' });
  }
};

/**
 * Live per-room user counts (Redis-pipelined, cross-instance accurate —
 * see roomPresenceService.ts) replace the old per-room, per-request logic
 * that trusted the local Socket.IO adapter first and fell back to the
 * always-empty Room.participants field as a last resort.
 */
export const getActiveRoomsList = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const rooms = await RoomModel.find({
      isEnded: { $ne: true },
      isLocked: { $ne: true },
      expiresAt: { $gt: now }
    })
      .select('code name createdAt')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const counts = await getLiveUserCountsForRooms(getIoInstance(), rooms.map((r: any) => r.code));

    res.json({
      rooms: rooms.map((room: any) => ({
        code: room.code,
        name: room.name || room.code,
        status: 'Active',
        userCount: counts.get(room.code) ?? 0,
        createdAt: room.createdAt,
      })),
    });
  } catch (error: any) {
    logger.error('Error getting active rooms list', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to get active rooms list' });
  }
};

export const getLockedRoomsList = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const rooms = await RoomModel.find({
      isLocked: true,
      isEnded: { $ne: true }
    })
      .select('code name createdAt lockedAt')
      .sort({ lockedAt: -1 })
      .lean()
      .exec();

    const counts = await getLiveUserCountsForRooms(getIoInstance(), rooms.map((r: any) => r.code));

    res.json({
      rooms: rooms.map((room: any) => ({
        code: room.code,
        name: room.name || room.code,
        status: 'Locked',
        userCount: counts.get(room.code) ?? 0,
        createdAt: room.createdAt,
        lockedAt: room.lockedAt,
      })),
    });
  } catch (error: any) {
    logger.error('Error getting locked rooms list', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
    });
    res.status(500).json({ error: 'Failed to get locked rooms list' });
  }
};

export const vanishRoom = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const { roomCode } = req.params;
    const adminId = req.adminId || 'unknown';

    if (!roomCode) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    // Get room to determine previous status
    const room = await RoomModel.findOne({ code: roomCode }).lean();
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const previousStatus = room.isLocked ? 'locked' : 'active';

    // Invalidate cache
    await invalidateDashboardCache();

    // Vanish the room
    await adminVanishRoom(roomCode, adminId, previousStatus);

    res.json({
      success: true,
      message: `Room ${roomCode} has been vanished`,
      roomCode,
    });
  } catch (error: any) {
    logger.error('Error vanishing room', {
      error: error instanceof Error ? error.message : String(error),
      adminId: req.adminId,
      roomCode: req.params.roomCode,
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to vanish room',
    });
  }
};

/** GET /admin/rooms/:code — look up a single room by code (used by the Sponsor Banner Manager). */
export const getRoomDetailByCode = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    const room = await RoomModel.findOne({ code })
      .select('code name isLocked isEnded plan createdAt expiresAt')
      .lean();

    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    res.json({
      room: {
        code: room.code,
        name: room.name || room.code,
        isLocked: !!room.isLocked,
        isEnded: !!room.isEnded,
        plan: room.plan || 'free',
        createdAt: room.createdAt,
        expiresAt: room.expiresAt,
      },
    });
  } catch (error: any) {
    logger.error('Error fetching room detail', {
      error: error instanceof Error ? error.message : String(error),
      roomCode: req.params.code,
    });
    res.status(500).json({ error: 'Failed to fetch room detail' });
  }
};
