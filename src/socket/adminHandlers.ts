import { Server, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { invalidateAdminCache } from '../middleware/adminCache.js';
import { getIoInstance } from './ioInstance.js';

const ADMIN_ROOM = 'admin:insights';
const getRedis = () => getRedisClient();

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

// Helper to calculate current insights from database (source of truth)
const calculateInsights = async () => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
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
      RoomModel.countDocuments({}),
      RoomModel.countDocuments({
        isEnded: { $ne: true },
        isLocked: { $ne: true },
        expiresAt: { $gt: now }
      }),
      RoomModel.countDocuments({
        isLocked: true,
        isEnded: { $ne: true }
      }),
      RoomModel.countDocuments({
        isLocked: true,
        lockedAt: { 
          $exists: true,
          $gte: oneDayAgo,
          $lte: now
        },
        isEnded: { $ne: true },
        expiresAt: { $gt: now }
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
      ]),
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
      }).select('createdAt').lean(),
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
      ]),
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
      ])
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
      ]),
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
      ])
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
      }),
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
      ]),
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
      ])
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
      ]),
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
      ]),
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
      ]),
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
      ])
    ]);

    // User Status metrics
    const [
      usersActiveToday,
      usersInActiveRooms,
      usersInLockedRoomsList,
      usersInAutoVanishRoomsList,
      peakConcurrentUsersToday
    ] = await Promise.all([
      // Users active today (unique users who joined any room today)
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
      ]),
      // Users in active rooms
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
      ]),
      // Users in locked rooms
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
      ]),
      // Users in auto-vanish rooms
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
      ]),
      // Peak concurrent users today (max users in any single room created today)
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
      ])
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
      // Users joined today (unique users across all rooms created today)
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
      ]),
      // Users joined yesterday
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
      ]),
      // Day-wise users joined (last 30 days) - for chart
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
      ]),
      // Total unique users (lifetime) - all unique participants across all rooms
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
      ])
    ]);

    // Engagement metrics
    const [
      averageUsersPerRoom,
      usersWhoSentMessageToday,
      silentUsersToday,
      averageSessionDuration
    ] = await Promise.all([
      // Average users per room
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
      ]),
      // Users who sent at least one message today
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
      ]),
      // Silent users (joined but no messages) - users in rooms created today but no messages
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
      ]),
      // Average session duration (estimated from room join to last message or room expiry)
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
      ])
    ]);

    // System Signals metrics
    // Note: These would ideally be tracked in Redis, but for now we'll use placeholders
    // In production, you'd track these in Redis counters
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
    }).select('participants').lean();

    const usersInLockedRooms = new Set<string>();
    lockedRoomsList.forEach((room: any) => {
      if (room.participants && Array.isArray(room.participants)) {
        room.participants.forEach((userId: string) => usersInLockedRooms.add(userId));
      }
    });

    // Get users online from Redis
    let usersOnline = 0;
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      try {
        const keys = await redis.keys('room:*:users');
        const userIds = new Set<string>();
        for (const key of keys) {
          const roomUsers = await redis.smembers(key);
          roomUsers.forEach((userId: string) => userIds.add(userId));
        }
        usersOnline = userIds.size;
      } catch (error: any) {
        logger.warn('Failed to get online users from Redis', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Process day-wise charts
    const roomsCreatedChart = getDayWiseData(thirtyDaysAgo, now, roomsCreatedLast30Days.map((r: any) => ({ date: r.createdAt })));
    // messagesLast30Days is already aggregated by day, just need to fill missing dates
    const messagesChart = (() => {
      const dataMap = new Map<string, number>();
      messagesLast30Days.forEach((d: any) => {
        dataMap.set(d._id, d.count);
      });
      
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
    const vanishedByAdmin = vanishedByAdminVsAuto.find((v: any) => v._id && v._id !== 'auto')?.count || 0;
    const vanishedByAuto = vanishedByAdminVsAuto.find((v: any) => v._id === 'auto' || !v._id)?.count || 0;

    return {
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
        usersJoinedLast30Days.forEach((d: any) => {
          dataMap.set(d._id, d.count);
        });
        
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
        active: (storageByRoomStatus.find((s: any) => s._id === 'active')?.totalSize || 0) / (1024 * 1024),
        locked: (storageByRoomStatus.find((s: any) => s._id === 'locked')?.totalSize || 0) / (1024 * 1024),
        'auto-vanish': (storageByRoomStatus.find((s: any) => s._id === 'auto-vanish')?.totalSize || 0) / (1024 * 1024),
        ended: (storageByRoomStatus.find((s: any) => s._id === 'ended')?.totalSize || 0) / (1024 * 1024),
        expired: (storageByRoomStatus.find((s: any) => s._id === 'expired')?.totalSize || 0) / (1024 * 1024)
      },
      storagePerRoomTop: storagePerRoomTop.map((room: any) => ({
        roomCode: room.roomCode,
        roomName: room.roomName,
        totalSize: room.totalSize / (1024 * 1024), // Convert to MB
        fileCount: room.fileCount,
        isLocked: room.isLocked,
        isEnded: room.isEnded
      })),
      
      // System
      socketConnectionsLive,
      failedRoomJoins,
      autoVanishJobsRunning,
      
      // Legacy fields for backward compatibility
      vanishedToday: vanishedTodayResult[0]?.count || 0,
      roomsExpiringInNextHour: roomsExpiringNextHour,
      roomsExpiringToday: roomsExpiringToday,
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    logger.error('Error calculating insights', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
};

// Emit insight update to all admin clients
export const emitAdminInsightUpdate = async (io: Server, event: string, data?: any): Promise<void> => {
  try {
    // Invalidate cache when events occur
    await invalidateAdminCache('insights');
    
    const insights = await calculateInsights();
    io.to(ADMIN_ROOM).emit('admin:insight_update', {
      event,
      data,
      insights,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error('Error emitting admin insight update', { 
      error: error instanceof Error ? error.message : String(error),
      event 
    });
  }
};

// Handle admin socket connections
export const handleAdminSocketConnection = (io: Server, socket: Socket): void => {
  const adminSecret = socket.handshake.auth?.adminSecret || socket.handshake.query?.adminSecret;

  // Verify admin secret
  if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
    logger.warn('Unauthorized admin socket connection attempt', { 
      ip: socket.handshake.address,
      socketId: socket.id 
    });
    socket.emit('error', { message: 'Unauthorized' });
    socket.disconnect();
    return;
  }

  logger.info('Admin socket connected', { socketId: socket.id });

  // Join admin room
  socket.join(ADMIN_ROOM);

  // Send initial insights on connection (rehydration)
  calculateInsights()
    .then(insights => {
      socket.emit('admin:insights_snapshot', {
        insights,
        timestamp: new Date().toISOString()
      });
    })
    .catch(error => {
      logger.error('Error sending initial insights', { error: error instanceof Error ? error.message : String(error) });
      socket.emit('error', { message: 'Failed to load insights' });
    });

  // Handle admin disconnect
  socket.on('disconnect', () => {
    logger.info('Admin socket disconnected', { socketId: socket.id });
  });

  // Handle manual refresh request
  socket.on('admin:refresh_insights', async () => {
    try {
      const insights = await calculateInsights();
      socket.emit('admin:insights_snapshot', {
        insights,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      logger.error('Error refreshing insights', { error: error instanceof Error ? error.message : String(error) });
      socket.emit('error', { message: 'Failed to refresh insights' });
    }
  });
};

