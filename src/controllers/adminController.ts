import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { UserVisitModel } from '../models/UserVisit.js';
import { GlobalStatsModel } from '../models/GlobalStats.js';
import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { AdminRequest } from '../middleware/adminAuth.js';
import { invalidateAdminCache } from '../middleware/adminCache.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { adminVanishRoom } from '../services/adminRoomService.js';

const getRedis = () => getRedisClient();

/**
 * Get start of day in server timezone (not UTC)
 */
const getStartOfDay = (): Date => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  return startOfDay;
};

/**
 * Get or create global stat counter (for persistent visit tracking)
 */
const getOrCreateGlobalStat = async (key: string, defaultValue: number = 0): Promise<number> => {
  try {
    let stat = await GlobalStatsModel.findOne({ key });
    if (!stat) {
      stat = await GlobalStatsModel.create({ key, value: defaultValue });
    }
    return stat.value;
  } catch (error: any) {
    logger.warn(`Failed to get global stat ${key}`, { error: error instanceof Error ? error.message : String(error) });
    return defaultValue;
  }
};

/**
 * Increment global stat counter atomically
 */
const incrementGlobalStat = async (key: string, increment: number = 1): Promise<void> => {
  try {
    await GlobalStatsModel.findOneAndUpdate(
      { key },
      { $inc: { value: increment }, $set: { lastUpdated: new Date() } },
      { upsert: true, new: true }
    );
  } catch (error: any) {
    logger.warn(`Failed to increment global stat ${key}`, { error: error instanceof Error ? error.message : String(error) });
  }
};

export const getTotalRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const count = await RoomModel.countDocuments({});
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
    
    // Get all unique user IDs from all room:code:users sets
    const keys = await redis.keys('room:*:users');
    const userIds = new Set<string>();
    
    for (const key of keys) {
      const roomUsers = await redis.smembers(key);
      roomUsers.forEach((userId: string) => userIds.add(userId));
    }
    
    res.json({ usersOnline: userIds.size });
  } catch (error: any) {
    logger.error('Error getting users online', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get users online' });
  }
};

export const getUsersInLockedRooms = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const lockedRooms = await RoomModel.find({
      isLocked: true,
      isEnded: { $ne: true }
    }).select('code participants');
    
    const userIds = new Set<string>();
    lockedRooms.forEach(room => {
      if (room.participants && Array.isArray(room.participants)) {
        room.participants.forEach((userId: string) => userIds.add(userId));
      }
    });
    
    res.json({ usersInLockedRooms: userIds.size });
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

// Helper to get day-wise data for last 30 days
const getDayWiseData = (startDate: Date, endDate: Date, data: Array<{ date: Date }>) => {
  const daysMap = new Map<string, number>();
  const current = new Date(startDate);
  
  while (current <= endDate) {
    const dayKey = current.toISOString().split('T')[0];
    daysMap.set(dayKey, 0);
    current.setDate(current.getDate() + 1);
  }
  
  data.forEach(item => {
    const dayKey = new Date(item.date).toISOString().split('T')[0];
    const count = daysMap.get(dayKey) || 0;
    daysMap.set(dayKey, count + 1);
  });
  
  return Array.from(daysMap.entries()).map(([date, count]) => ({ date, count }));
};

export const getDashboardInsights = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    // Check database connection
    if (mongoose.connection.readyState !== 1) {
      logger.warn('Database not connected when getting dashboard insights');
      res.status(503).json({ error: 'Database not connected' });
      return;
    }

    // Use server timezone (not UTC) for "Today" definition
    const now = new Date();
    const startOfDay = getStartOfDay();
    const endOfDay = new Date(startOfDay);
    endOfDay.setHours(23, 59, 59, 999);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Overview & Rooms metrics
    const [
      totalRooms,
      activeRooms,
      lockedRooms,
      autoVanishRooms,
      vanishedTodayResult,
      roomsExpiringNextHour,
      roomsExpiringToday,
      roomsCreatedToday,
      roomsCreatedLast30Days,
      roomsEligibleToVanishNow,
      vanishedByAdminVsAuto,
      averageRoomLifetime
    ] = await Promise.all([
      // Total Rooms (Lifetime): Use estimatedDocumentCount for performance
      RoomModel.estimatedDocumentCount().catch(() => RoomModel.countDocuments({})),
      // Active Rooms: expiresAt > now
      RoomModel.countDocuments({
        expiresAt: { $gt: now },
        isEnded: { $ne: true },
        isLocked: { $ne: true }
      }),
      // Locked Rooms: isLocked = true
      RoomModel.countDocuments({
        isLocked: true,
        isEnded: { $ne: true }
      }),
      // Auto-Vanish Rooms (Pending < 24h): expiresAt between now and tomorrow
      RoomModel.countDocuments({
        expiresAt: { $gt: now, $lt: tomorrow },
        isLocked: true,
        isEnded: { $ne: true }
      }),
      RoomModel.aggregate([
        {
          $match: {
            $or: [
              { isEnded: true, endedAt: { $gte: startOfDay, $lte: endOfDay } },
              { expiresAt: { $gte: startOfDay, $lte: endOfDay } }
            ]
          }
        },
        { $count: 'count' }
      ]).allowDiskUse(true),
      RoomModel.countDocuments({
        expiresAt: {
          $gte: now,
          $lte: oneHourFromNow
        },
        isEnded: { $ne: true }
      }),
      RoomModel.countDocuments({
        expiresAt: {
          $gte: startOfDay,
          $lte: endOfDay
        },
        isEnded: { $ne: true }
      }),
      RoomModel.countDocuments({
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      }),
      RoomModel.find({
        createdAt: { $gte: thirtyDaysAgo, $lte: now }
      }).select('createdAt').lean().exec(),
      RoomModel.countDocuments({
        isLocked: true,
        lockedAt: {
          $exists: true,
          $lt: oneDayAgo
        },
        isEnded: { $ne: true },
        expiresAt: { $gt: now }
      }),
      RoomModel.aggregate([
        {
          $match: {
            isEnded: true,
            endedAt: { $gte: startOfDay, $lte: endOfDay }
          }
        },
        {
          $group: {
            _id: '$endedBy',
            count: { $sum: 1 }
          }
        }
      ]).allowDiskUse(true),
      RoomModel.aggregate([
        {
          $match: {
            isEnded: true,
            endedAt: { $gte: thirtyDaysAgo }
          }
        },
        {
          $project: {
            lifetime: {
              $subtract: ['$endedAt', '$createdAt']
            }
          }
        },
        {
          $group: {
            _id: null,
            avgLifetime: { $avg: '$lifetime' }
          }
        }
      ]).allowDiskUse(true)
    ]);

    // Messages metrics - Using Aggregation Pipelines
    const [
      messagesSentToday,
      messagesLast30Days,
      peakMessagingTimeToday
    ] = await Promise.all([
      // Messages Sent Today
      MessageModel.countDocuments({
        createdAt: { $gte: startOfDay, $lte: endOfDay },
        deletedByAdmin: { $ne: true }
      }),
      MessageModel.aggregate([
        {
          $match: {
            createdAt: { $gte: thirtyDaysAgo, $lte: now },
            deletedByAdmin: { $ne: true }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]).allowDiskUse(true),
      MessageModel.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            deletedByAdmin: { $ne: true }
          }
        },
        {
          $group: {
            _id: { $hour: '$createdAt' },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]).allowDiskUse(true)
    ]);

    // Files metrics - Using Aggregation Pipelines
    const [
      filesSharedToday,
      storageUsedToday,
      fileStats
    ] = await Promise.all([
      // Files Shared Today: type = 'file'
      MessageModel.countDocuments({
        type: 'file',
        createdAt: { $gte: startOfDay, $lte: endOfDay },
        deletedByAdmin: { $ne: true }
      }),
      // Storage Used Today: Aggregate sum of fileMeta.size
      MessageModel.aggregate([
        {
          $match: {
            type: 'file',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            deletedByAdmin: { $ne: true },
            'fileMeta.size': { $exists: true, $gt: 0 }
          }
        },
        {
          $group: {
            _id: null,
            totalSize: { $sum: '$fileMeta.size' }
          }
        }
      ]).allowDiskUse(true),
      MessageModel.aggregate([
        {
          $match: {
            type: 'file',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            deletedByAdmin: { $ne: true },
            'fileMeta.mimeType': { $exists: true }
          }
        },
        {
          $group: {
            _id: '$fileMeta.mimeType',
            count: { $sum: 1 },
            avgSize: { $avg: '$fileMeta.size' }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]).allowDiskUse(true)
    ]);

    // Storage Usage Insights - Comprehensive metrics
    const [
      totalStorageUsed,
      storageUsedLast30Days,
      storageByRoomStatus,
      storagePerRoomTop
    ] = await Promise.all([
      // Total storage used (all rooms, all time)
      MessageModel.aggregate([
        {
          $match: {
            type: 'file',
            deletedByAdmin: { $ne: true },
            'fileMeta.size': { $exists: true, $gt: 0 }
          }
        },
        {
          $group: {
            _id: null,
            totalSize: { $sum: '$fileMeta.size' }
          }
        }
      ]).allowDiskUse(true),
      // Storage used in last 30 days
      MessageModel.aggregate([
        {
          $match: {
            type: 'file',
            createdAt: { $gte: thirtyDaysAgo, $lte: now },
            deletedByAdmin: { $ne: true },
            'fileMeta.size': { $exists: true, $gt: 0 }
          }
        },
        {
          $group: {
            _id: null,
            totalSize: { $sum: '$fileMeta.size' }
          }
        }
      ]).allowDiskUse(true),
      // Storage used by room status (active / locked / auto-vanish)
      MessageModel.aggregate([
        {
          $match: {
            type: 'file',
            deletedByAdmin: { $ne: true },
            'fileMeta.size': { $exists: true, $gt: 0 }
          }
        },
        {
          $lookup: {
            from: 'rooms',
            localField: 'roomCode',
            foreignField: 'code',
            as: 'room'
          }
        },
        {
          $unwind: { path: '$room', preserveNullAndEmptyArrays: true }
        },
        {
          $project: {
            size: '$fileMeta.size',
            roomStatus: {
              $cond: [
                { $eq: ['$room.isEnded', true] },
                'ended',
                {
                  $cond: [
                    { $eq: ['$room.isLocked', true] },
                    {
                      $cond: [
                        {
                          $and: [
                            { $ne: ['$room.lockedAt', null] },
                            { $lt: ['$room.lockedAt', oneDayAgo] },
                            { $gt: ['$room.expiresAt', now] }
                          ]
                        },
                        'auto-vanish',
                        'locked'
                      ]
                    },
                    {
                      $cond: [
                        { $gt: ['$room.expiresAt', now] },
                        'active',
                        'expired'
                      ]
                    }
                  ]
                }
              ]
            }
          }
        },
        {
          $group: {
            _id: '$roomStatus',
            totalSize: { $sum: '$size' }
          }
        }
      ]).allowDiskUse(true),
      // Storage per room (top rooms by storage)
      MessageModel.aggregate([
        {
          $match: {
            type: 'file',
            deletedByAdmin: { $ne: true },
            'fileMeta.size': { $exists: true, $gt: 0 }
          }
        },
        {
          $group: {
            _id: '$roomCode',
            totalSize: { $sum: '$fileMeta.size' },
            fileCount: { $sum: 1 }
          }
        },
        {
          $lookup: {
            from: 'rooms',
            localField: '_id',
            foreignField: 'code',
            as: 'room'
          }
        },
        {
          $unwind: { path: '$room', preserveNullAndEmptyArrays: true }
        },
        {
          $project: {
            roomCode: '$_id',
            totalSize: 1,
            fileCount: 1,
            roomName: { $ifNull: ['$room.name', 'Unknown'] },
            isLocked: { $ifNull: ['$room.isLocked', false] },
            isEnded: { $ifNull: ['$room.isEnded', false] }
          }
        },
        { $sort: { totalSize: -1 } },
        { $limit: 50 }
      ]).allowDiskUse(true)
    ]);

    // User Status metrics
    const [
      usersActiveToday,
      usersInActiveRooms,
      usersInLockedRoomsList,
      usersInAutoVanishRoomsList,
      peakConcurrentUsersToday
    ] = await Promise.all([
      RoomModel.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfDay, $lte: endOfDay }
          }
        },
        {
          $unwind: { path: '$participants', preserveNullAndEmptyArrays: true }
        },
        {
          $group: {
            _id: '$participants'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      RoomModel.aggregate([
        {
          $match: {
            isEnded: { $ne: true },
            isLocked: { $ne: true },
            expiresAt: { $gt: now }
          }
        },
        {
          $unwind: { path: '$participants', preserveNullAndEmptyArrays: true }
        },
        {
          $group: {
            _id: '$participants'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      RoomModel.aggregate([
        {
          $match: {
            isLocked: true,
            isEnded: { $ne: true }
          }
        },
        {
          $unwind: { path: '$participants', preserveNullAndEmptyArrays: true }
        },
        {
          $group: {
            _id: '$participants'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      RoomModel.aggregate([
        {
          $match: {
            isLocked: true,
            isEnded: { $ne: true },
            expiresAt: { $gt: now },
            lockedAt: {
              $exists: true,
              $gte: oneDayAgo,
              $lte: now
            }
          }
        },
        {
          $unwind: { path: '$participants', preserveNullAndEmptyArrays: true }
        },
        {
          $group: {
            _id: '$participants'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      RoomModel.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfDay, $lte: endOfDay }
          }
        },
        {
          $project: {
            participantCount: { $size: { $ifNull: ['$participants', []] } }
          }
        },
        {
          $group: {
            _id: null,
            maxUsers: { $max: '$participantCount' }
          }
        }
      ]).allowDiskUse(true)
    ]);

    // User Growth metrics - using UserVisit for accurate tracking
    const yesterdayStart = new Date(startOfDay);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    const yesterdayEnd = new Date(startOfDay);
    
    const [
      usersJoinedToday,
      usersJoinedYesterday,
      usersJoinedLast30Days,
      totalUniqueUsersLifetime,
      totalUserVisitsLifetime,
      totalUserVisitsToday,
      uniqueUsersFromMessages
    ] = await Promise.all([
      // Unique users who joined rooms today (from UserVisit)
      UserVisitModel.aggregate([
        {
          $match: {
            joinedAt: { $gte: startOfDay, $lte: endOfDay }
          }
        },
        {
          $group: {
            _id: '$userId'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      // Unique users who joined rooms yesterday (from UserVisit)
      UserVisitModel.aggregate([
        {
          $match: {
            joinedAt: { $gte: yesterdayStart, $lte: yesterdayEnd }
          }
        },
        {
          $group: {
            _id: '$userId'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      // Day-wise unique users joined (last 30 days) - for chart
      UserVisitModel.aggregate([
        {
          $match: {
            joinedAt: { $gte: thirtyDaysAgo, $lte: now }
          }
        },
        {
          $project: {
            userId: 1,
            date: { $dateToString: { format: '%Y-%m-%d', date: '$joinedAt' } }
          }
        },
        {
          $group: {
            _id: { date: '$date', userId: '$userId' }
          }
        },
        {
          $group: {
            _id: '$_id.date',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]).allowDiskUse(true),
      // Total unique users lifetime (from UserVisit - most accurate)
      UserVisitModel.aggregate([
        {
          $group: {
            _id: '$userId'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      // Total Visits (Lifetime): Use GlobalStats counter (fast) or fallback to count
      getOrCreateGlobalStat('totalVisitsLifetime').then(async (cached) => {
        if (cached > 0) return cached;
        // If counter is 0 or doesn't exist, count from UserVisit and update counter
        const count = await UserVisitModel.countDocuments({});
        if (count > 0) {
          await GlobalStatsModel.findOneAndUpdate(
            { key: 'totalVisitsLifetime' },
            { $set: { value: count, lastUpdated: new Date() } },
            { upsert: true }
          );
        }
        return count || 0; // Ensure we always return a number
      }).catch(() => {
        // Fallback if getOrCreateGlobalStat fails
        return UserVisitModel.countDocuments({}).catch(() => 0);
      }),
      // Visits Today: count from UserVisit
      UserVisitModel.countDocuments({
        joinedAt: { $gte: startOfDay, $lte: endOfDay }
      }),
      // Unique users from messages (fallback/alternative metric)
      MessageModel.aggregate([
        {
          $group: {
            _id: '$userId'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true)
    ]);

    // Engagement metrics
    const [
      averageUsersPerRoom,
      usersWhoSentMessageToday,
      silentUsersToday,
      averageSessionDuration
    ] = await Promise.all([
      RoomModel.aggregate([
        {
          $match: {
            isEnded: { $ne: true },
            expiresAt: { $gt: now }
          }
        },
        {
          $project: {
            participantCount: { $size: { $ifNull: ['$participants', []] } }
          }
        },
        {
          $group: {
            _id: null,
            avgUsers: { $avg: '$participantCount' },
            roomCount: { $sum: 1 }
          }
        }
      ]).allowDiskUse(true),
      MessageModel.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            deletedByAdmin: { $ne: true }
          }
        },
        {
          $group: {
            _id: '$userId'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      RoomModel.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfDay, $lte: endOfDay }
          }
        },
        {
          $lookup: {
            from: 'messages',
            let: { roomCode: '$code', participants: '$participants' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$roomCode', '$$roomCode'] },
                      { $in: ['$userId', '$$participants'] },
                      { $gte: ['$createdAt', startOfDay] },
                      { $lte: ['$createdAt', endOfDay] }
                    ]
                  },
                  deletedByAdmin: { $ne: true }
                }
              },
              {
                $group: {
                  _id: '$userId'
                }
              }
            ],
            as: 'usersWithMessages'
          }
        },
        {
          $project: {
            participants: 1,
            usersWithMessages: { $map: { input: '$usersWithMessages', as: 'u', in: '$$u._id' } }
          }
        },
        {
          $unwind: { path: '$participants', preserveNullAndEmptyArrays: true }
        },
        {
          $match: {
            $expr: {
              $not: { $in: ['$participants', '$usersWithMessages'] }
            }
          }
        },
        {
          $group: {
            _id: '$participants'
          }
        },
        {
          $count: 'count'
        }
      ]).allowDiskUse(true),
      RoomModel.aggregate([
        {
          $match: {
            isEnded: true,
            endedAt: { $gte: thirtyDaysAgo }
          }
        },
        {
          $lookup: {
            from: 'messages',
            let: { roomCode: '$code' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$roomCode', '$$roomCode'] },
                  deletedByAdmin: { $ne: true }
                }
              },
              {
                $sort: { createdAt: -1 }
              },
              {
                $limit: 1
              },
              {
                $project: {
                  lastMessageTime: '$createdAt'
                }
              }
            ],
            as: 'lastMessage'
          }
        },
        {
          $project: {
            sessionDuration: {
              $subtract: [
                { $ifNull: [{ $arrayElemAt: ['$lastMessage.lastMessageTime', 0] }, '$endedAt'] },
                '$createdAt'
              ]
            }
          }
        },
        {
          $match: {
            sessionDuration: { $gt: 0 }
          }
        },
        {
          $group: {
            _id: null,
            avgDuration: { $avg: '$sessionDuration' }
          }
        }
      ]).allowDiskUse(true)
    ]);

    const { getTodayMetrics } = await import('../services/platformMetricsService.js');
    const platformMetrics = getTodayMetrics();

    // System Signals metrics (live counters)
    const reconnectAttempts = platformMetrics.reconnectAttempts;
    const failedJoinAttempts = platformMetrics.failedJoinAttempts;
    const usersBlockedLockedVanished = platformMetrics.usersBlockedLockedVanished;

    // System metrics
    const io = getIoInstance();
    const socketConnectionsLive = io ? io.sockets.sockets.size : 0;
    const failedRoomJoins = platformMetrics.failedRoomJoins;
    const autoVanishJobsRunning = 1; // Assuming one job is always running

    // Get users in locked rooms
    const lockedRoomsList = await RoomModel.find({
      isLocked: true,
      isEnded: { $ne: true }
    })
      .select('participants')
      .lean()
      .limit(10000)
      .exec();
    
    const usersInLockedRooms = new Set<string>();
    lockedRoomsList.forEach((room: any) => {
      if (room.participants && Array.isArray(room.participants)) {
        room.participants.forEach((userId: string) => usersInLockedRooms.add(userId));
      }
    });
    
    // Users Online: Get from Socket.IO directly (real-time, not from DB)
    // Reuse io variable declared above
    const usersOnline = io ? (io.engine?.clientsCount || io.sockets.sockets.size || 0) : 0;

    // Process day-wise charts
    const roomsCreatedChart = getDayWiseData(thirtyDaysAgo, now, Array.isArray(roomsCreatedLast30Days) ? roomsCreatedLast30Days.map((r: any) => ({ date: r.createdAt })) : []);
    // messagesLast30Days is already aggregated by day, just need to fill missing dates
    const messagesChart = (() => {
      const dataMap = new Map<string, number>();
      if (Array.isArray(messagesLast30Days)) {
        messagesLast30Days.forEach((d: any) => {
          dataMap.set(d._id, d.count);
        });
      }
      
      const result: Array<{ date: string; count: number }> = [];
      const current = new Date(thirtyDaysAgo);
      while (current <= now) {
        const dateKey = current.toISOString().split('T')[0];
        result.push({
          date: dateKey,
          count: dataMap.get(dateKey) || 0
        });
        current.setDate(current.getDate() + 1);
      }
      return result;
    })();

    // Process vanished by admin vs auto
    const vanishedByAdmin = Array.isArray(vanishedByAdminVsAuto) ? vanishedByAdminVsAuto.find((v: any) => v && v._id && v._id !== 'auto')?.count || 0 : 0;
    const vanishedByAuto = Array.isArray(vanishedByAdminVsAuto) ? vanishedByAdminVsAuto.find((v: any) => v && (v._id === 'auto' || !v._id))?.count || 0 : 0;
    
    res.json({
      // Overview
      totalRooms: totalRooms || 0,
      activeRooms: activeRooms || 0,
      lockedRooms: lockedRooms || 0,
      autoVanishRooms: autoVanishRooms || 0,
      usersOnline: usersOnline || 0,
      messagesSentToday: messagesSentToday || 0,
      filesSharedToday: filesSharedToday || 0,
      storageUsedToday: (storageUsedToday[0]?.totalSize || 0) / (1024 * 1024), // Convert to MB
      
      // Rooms
      roomsCreatedToday: roomsCreatedToday || 0,
      roomsCreatedChart,
      roomsCurrentlyActive: activeRooms,
      roomsLocked: lockedRooms,
      roomsInAutoVanishCountdown: autoVanishRooms,
      roomsEligibleToVanishNow: roomsEligibleToVanishNow || 0,
      vanishedByAdmin,
      vanishedByAuto,
      averageRoomLifetime: averageRoomLifetime[0]?.avgLifetime ? averageRoomLifetime[0].avgLifetime / (1000 * 60 * 60) : 0, // Convert to hours
      
      // User Status
      usersActiveToday: usersActiveToday[0]?.count || 0,
      peakConcurrentUsersToday: peakConcurrentUsersToday[0]?.maxUsers || 0,
      usersInActiveRooms: usersInActiveRooms[0]?.count || 0,
      usersInLockedRooms: usersInLockedRoomsList[0]?.count || 0,
      usersInAutoVanishRooms: usersInAutoVanishRoomsList[0]?.count || 0,
      
      // User Growth
      usersJoinedToday: usersJoinedToday[0]?.count || 0,
      usersJoinedYesterday: usersJoinedYesterday[0]?.count || 0,
      usersJoinedChart: (() => {
        // Convert aggregation result to chart format and fill missing dates
        const dataMap = new Map<string, number>();
        if (Array.isArray(usersJoinedLast30Days)) {
          usersJoinedLast30Days.forEach((d: any) => {
            dataMap.set(d._id, d.count);
          });
        }
        
        const result: Array<{ date: string; count: number }> = [];
        const current = new Date(thirtyDaysAgo);
        while (current <= now) {
          const dateKey = current.toISOString().split('T')[0];
          result.push({
            date: dateKey,
            count: dataMap.get(dateKey) || 0
          });
          current.setDate(current.getDate() + 1);
        }
        return result;
      })(),
      totalUniqueUsersLifetime: totalUniqueUsersLifetime[0]?.count || uniqueUsersFromMessages[0]?.count || 0,
      totalUserVisitsLifetime: totalUserVisitsLifetime || 0,
      totalUserVisitsToday: totalUserVisitsToday || 0,
      
      // Engagement
      averageUsersPerRoom: averageUsersPerRoom[0]?.avgUsers || 0,
      usersWhoSentMessageToday: usersWhoSentMessageToday[0]?.count || 0,
      silentUsersToday: silentUsersToday[0]?.count || 0,
      averageSessionDuration: averageSessionDuration[0]?.avgDuration ? averageSessionDuration[0].avgDuration / (1000 * 60) : 0, // Convert to minutes
      
      // System Signals
      reconnectAttempts: reconnectAttempts || 0,
      failedJoinAttempts: failedJoinAttempts || 0,
      usersBlockedLockedVanished: usersBlockedLockedVanished || 0,
      
      // Messages
      messagesChart: messagesChart || [],
      peakMessagingTimeToday: peakMessagingTimeToday[0]?._id !== undefined ? `${peakMessagingTimeToday[0]._id}:00` : 'N/A',
      
      // Files
      averageFileSize: fileStats[0]?.avgSize ? fileStats[0].avgSize / (1024 * 1024) : 0, // Convert to MB
      mostCommonFileType: fileStats[0]?._id || 'N/A',
      
      // Storage Usage Insights
      totalStorageUsed: (totalStorageUsed[0]?.totalSize || 0) / (1024 * 1024), // Convert to MB
      storageUsedLast30Days: (storageUsedLast30Days[0]?.totalSize || 0) / (1024 * 1024), // Convert to MB
      storageByRoomStatus: {
        active: (Array.isArray(storageByRoomStatus) ? storageByRoomStatus.find((s: any) => s._id === 'active')?.totalSize || 0 : 0) / (1024 * 1024),
        locked: (Array.isArray(storageByRoomStatus) ? storageByRoomStatus.find((s: any) => s._id === 'locked')?.totalSize || 0 : 0) / (1024 * 1024),
        'auto-vanish': (Array.isArray(storageByRoomStatus) ? storageByRoomStatus.find((s: any) => s._id === 'auto-vanish')?.totalSize || 0 : 0) / (1024 * 1024),
        ended: (Array.isArray(storageByRoomStatus) ? storageByRoomStatus.find((s: any) => s._id === 'ended')?.totalSize || 0 : 0) / (1024 * 1024),
        expired: (Array.isArray(storageByRoomStatus) ? storageByRoomStatus.find((s: any) => s._id === 'expired')?.totalSize || 0 : 0) / (1024 * 1024)
      },
      storagePerRoomTop: Array.isArray(storagePerRoomTop) ? storagePerRoomTop.map((room: any) => ({
        roomCode: room.roomCode,
        roomName: room.roomName,
        totalSize: room.totalSize / (1024 * 1024), // Convert to MB
        fileCount: room.fileCount,
        isLocked: room.isLocked,
        isEnded: room.isEnded
      })) : [],
      
      // System
      socketConnectionsLive: socketConnectionsLive || 0,
      failedRoomJoins: failedRoomJoins || 0,
      uploadFailuresToday: platformMetrics.uploadFailures,
      uploadsGcsToday: platformMetrics.uploadsGcs,
      uploadsLocalToday: platformMetrics.uploadsLocal,
      gcsFallbackRate: platformMetrics.gcsFallbackRate,
      uploadSuccessRate: platformMetrics.uploadSuccessRate,
      autoVanishJobsRunning: autoVanishJobsRunning || 0,
      
      // Legacy fields for backward compatibility
      vanishedToday: vanishedTodayResult[0]?.count || 0,
      roomsExpiringInNextHour: roomsExpiringNextHour,
      roomsExpiringToday: roomsExpiringToday,
      timestamp: new Date().toISOString()
    });
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

export const getActiveRoomsList = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const rooms = await RoomModel.find({
      isEnded: { $ne: true },
      isLocked: { $ne: true },
      expiresAt: { $gt: now }
    })
      .select('code name createdAt participants')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const redis = getRedis();
    const io = getIoInstance();
    const roomsWithUserCounts = await Promise.all(
      rooms.map(async (room: any) => {
        let userCount = 0;
        let socketRoomExists = false;
        
        // Priority 1: Socket.IO (most real-time, reflects current connections)
        // If Socket.IO room exists (even with 0 users), use it as it's the most accurate current state
              if (io) {
                const socketRoom = io.sockets.adapter.rooms.get(room.code);
          if (socketRoom !== undefined) {
            // Room exists in Socket.IO - use its size (can be 0 if empty)
                  userCount = socketRoom.size;
            socketRoomExists = true;
          }
        }
        
        // Priority 2: Redis (only if Socket.IO room doesn't exist or Socket.IO is unavailable)
        // Use Redis if Socket.IO room doesn't exist, as it might have persistent tracking
        if (!socketRoomExists && redis && isRedisAvailable()) {
          try {
            // Check if the Redis key exists first
            const keyExists = await redis.exists(`room:${room.code}:users`);
            if (keyExists) {
              const redisCount = await redis.scard(`room:${room.code}:users`);
              if (redisCount > 0) {
                userCount = redisCount;
              }
            }
          } catch (error) {
            logger.warn(`Failed to get Redis count for room ${room.code}`, {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        
        // Priority 3: Fallback to participants array (last resort, may be outdated)
        // Only use if both Socket.IO and Redis returned 0 or are unavailable
        if (userCount === 0 && !socketRoomExists) {
          userCount = room.participants?.length || 0;
        }

        return {
          code: room.code,
          name: room.name || room.code,
          status: 'Active',
          userCount,
          createdAt: room.createdAt,
        };
      })
    );

    res.json({ rooms: roomsWithUserCounts });
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
      .select('code name createdAt participants lockedAt')
      .sort({ lockedAt: -1 })
      .lean()
      .exec();

    const redis = getRedis();
    const io = getIoInstance();
    const roomsWithUserCounts = await Promise.all(
      rooms.map(async (room: any) => {
        let userCount = 0;
        let socketRoomExists = false;
        
        // Priority 1: Socket.IO (most real-time, reflects current connections)
        // If Socket.IO room exists (even with 0 users), use it as it's the most accurate current state
        if (io) {
          const socketRoom = io.sockets.adapter.rooms.get(room.code);
          if (socketRoom !== undefined) {
            // Room exists in Socket.IO - use its size (can be 0 if empty)
            userCount = socketRoom.size;
            socketRoomExists = true;
          }
        }
        
        // Priority 2: Redis (only if Socket.IO room doesn't exist or Socket.IO is unavailable)
        // Use Redis if Socket.IO room doesn't exist, as it might have persistent tracking
        if (!socketRoomExists && redis && isRedisAvailable()) {
          try {
            // Check if the Redis key exists first
            const keyExists = await redis.exists(`room:${room.code}:users`);
            if (keyExists) {
              const redisCount = await redis.scard(`room:${room.code}:users`);
              if (redisCount > 0) {
                userCount = redisCount;
              }
            }
          } catch (error) {
            logger.warn(`Failed to get Redis count for locked room ${room.code}`, {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        
        // Priority 3: Fallback to participants array (last resort, may be outdated)
        // Only use if both Socket.IO and Redis returned 0 or are unavailable
        if (userCount === 0 && !socketRoomExists) {
          userCount = room.participants?.length || 0;
        }

        return {
      code: room.code,
      name: room.name || room.code,
      status: 'Locked',
          userCount,
      createdAt: room.createdAt,
      lockedAt: room.lockedAt,
        };
      })
    );

    res.json({ rooms: roomsWithUserCounts });
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
    await invalidateAdminCache('insights');

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

