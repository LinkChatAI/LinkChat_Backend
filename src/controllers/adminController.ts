import { Request, Response } from 'express';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { AdminRequest } from '../middleware/adminAuth.js';
import { invalidateAdminCache } from '../middleware/adminCache.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { adminVanishRoom } from '../services/adminRoomService.js';

const getRedis = () => getRedisClient();

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
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
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
      RoomModel.countDocuments({}).lean().exec(),
      RoomModel.countDocuments({
        isEnded: { $ne: true },
        isLocked: { $ne: true },
        expiresAt: { $gt: now }
      }).lean().exec(),
      RoomModel.countDocuments({
        isLocked: true,
        isEnded: { $ne: true }
      }).lean().exec(),
      RoomModel.countDocuments({
        isLocked: true,
        lockedAt: { 
          $exists: true,
          $gte: oneDayAgo,
          $lte: now
        },
        isEnded: { $ne: true },
        expiresAt: { $gt: now }
      }).lean().exec(),
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
      }).lean().exec(),
      RoomModel.countDocuments({
        expiresAt: {
          $gte: startOfDay,
          $lte: endOfDay
        },
        isEnded: { $ne: true }
      }).lean().exec(),
      RoomModel.countDocuments({
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      }).lean().exec(),
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
      }).lean().exec(),
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

    // Messages metrics
    const [
      messagesSentToday,
      messagesLast30Days,
      peakMessagingTimeToday
    ] = await Promise.all([
      MessageModel.countDocuments({
        createdAt: { $gte: startOfDay, $lte: endOfDay },
        deletedByAdmin: { $ne: true }
      }).lean().exec(),
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

    // Files metrics
    const [
      filesSharedToday,
      storageUsedToday,
      fileStats
    ] = await Promise.all([
      MessageModel.countDocuments({
        type: 'file',
        createdAt: { $gte: startOfDay, $lte: endOfDay },
        deletedByAdmin: { $ne: true }
      }).lean().exec(),
      MessageModel.aggregate([
        {
          $match: {
            type: 'file',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            deletedByAdmin: { $ne: true },
            'fileMeta.size': { $exists: true }
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

    // User Growth metrics
    const yesterdayStart = new Date(startOfDay);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(startOfDay);
    
    const [
      usersJoinedToday,
      usersJoinedYesterday,
      usersJoinedLast30Days,
      totalUniqueUsersLifetime
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
            createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd }
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
            createdAt: { $gte: thirtyDaysAgo, $lte: now }
          }
        },
        {
          $unwind: { path: '$participants', preserveNullAndEmptyArrays: true }
        },
        {
          $project: {
            userId: '$participants',
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
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
      RoomModel.aggregate([
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

    // System Signals metrics
    const reconnectAttempts = 0; // TODO: Track in Redis
    const failedJoinAttempts = 0; // TODO: Track in Redis
    const usersBlockedLockedVanished = 0; // TODO: Track in Redis

    // System metrics
    const io = getIoInstance();
    const socketConnectionsLive = io ? io.sockets.sockets.size : 0;
    const failedRoomJoins = 0; // TODO: Track in Redis
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
    
    // Get users online from Redis
    let usersOnline = 0;
    let usersOnlineNote = '';
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      try {
        const userIds = new Set<string>();
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'room:*:users', 'COUNT', 100);
          cursor = nextCursor;
          
          if (keys.length > 0) {
            const pipeline = redis.pipeline();
            keys.forEach((key: string) => pipeline.smembers(key));
            const results = await pipeline.exec();
            
            results?.forEach((result: any) => {
              if (result[1] && Array.isArray(result[1])) {
                result[1].forEach((userId: string) => userIds.add(userId));
              }
            });
          }
        } while (cursor !== '0');
        
        usersOnline = userIds.size;
      } catch (error: any) {
        usersOnlineNote = 'Redis query failed';
        logger.warn('Failed to get users online from Redis', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      usersOnlineNote = 'Redis not available';
    }

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
    const vanishedByAdmin = Array.isArray(vanishedByAdminVsAuto) ? vanishedByAdminVsAuto.find((v: any) => v._id && v._id !== 'auto')?.count || 0 : 0;
    const vanishedByAuto = Array.isArray(vanishedByAdminVsAuto) ? vanishedByAdminVsAuto.find((v: any) => v._id === 'auto' || !v._id)?.count || 0 : 0;
    
    res.json({
      // Overview
      totalRooms,
      activeRooms,
      lockedRooms,
      autoVanishRooms,
      usersOnline,
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
      totalUniqueUsersLifetime: totalUniqueUsersLifetime[0]?.count || 0,
      
      // Engagement
      averageUsersPerRoom: averageUsersPerRoom[0]?.avgUsers || 0,
      usersWhoSentMessageToday: usersWhoSentMessageToday[0]?.count || 0,
      silentUsersToday: silentUsersToday[0]?.count || 0,
      averageSessionDuration: averageSessionDuration[0]?.avgDuration ? averageSessionDuration[0].avgDuration / (1000 * 60) : 0, // Convert to minutes
      
      // System Signals
      reconnectAttempts,
      failedJoinAttempts,
      usersBlockedLockedVanished,
      
      // Messages
      messagesChart,
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
      socketConnectionsLive,
      failedRoomJoins,
      autoVanishJobsRunning,
      
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
        let userCount = room.participants?.length || 0;
        
        // Priority 1: Try to get real-time count from Redis (most accurate, persistent)
        if (redis && isRedisAvailable()) {
          try {
            const redisCount = await redis.scard(`room:${room.code}:users`);
            // Use Redis count if it's greater than 0 (means we have tracking data)
            // If Redis returns 0, it might mean no users OR Redis doesn't have data for this room
            // So we'll check Socket.IO as a fallback
            if (redisCount > 0) {
              userCount = redisCount;
            } else {
              // Redis returned 0, check Socket.IO for real-time count
              if (io) {
                const socketRoom = io.sockets.adapter.rooms.get(room.code);
                if (socketRoom && socketRoom.size > 0) {
                  userCount = socketRoom.size;
                }
                // If Socket.IO also returns 0, keep the participants array count
              }
            }
          } catch (error) {
            // Redis query failed, fall back to Socket.IO
            if (io) {
              const socketRoom = io.sockets.adapter.rooms.get(room.code);
              if (socketRoom) {
                userCount = socketRoom.size;
              }
            }
            logger.warn(`Failed to get Redis count for room ${room.code}`, {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        } else {
          // Redis not available, use Socket.IO as primary source
          if (io) {
            const socketRoom = io.sockets.adapter.rooms.get(room.code);
            if (socketRoom) {
              userCount = socketRoom.size;
            }
          }
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

    const roomsWithUserCounts = rooms.map((room: any) => ({
      code: room.code,
      name: room.name || room.code,
      status: 'Locked',
      userCount: room.participants?.length || 0,
      createdAt: room.createdAt,
      lockedAt: room.lockedAt,
    }));

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

