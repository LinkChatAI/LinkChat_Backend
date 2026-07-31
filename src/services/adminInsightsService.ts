import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { UserVisitModel } from '../models/UserVisit.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { getSelfHealingGlobalStat, getOrCreateGlobalStat } from '../utils/globalStats.js';
import { getLiveUserCountsForRooms, sumLiveUserCounts, getPlatformUsersOnline } from './roomPresenceService.js';
import { logger } from '../utils/logger.js';
import {
  getRoomsCreatedSeries,
  getMessagesSentSeries,
  getFilesSharedToday,
  getStorageBytesToday,
  getStorageBytesSeries,
  getPeakMessagingHourToday,
  getMessageSendersCountToday,
  getMessageSenderIdsToday,
  getUniqueUsersLifetimeCount,
  getPeakConcurrentToday,
  getRoomsVanishedTodayByCause,
} from './dailyStatsService.js';

/**
 * Single source of truth for the admin dashboard's ~40-field insights
 * bundle — computed once here and consumed by BOTH the REST endpoint
 * (adminController.ts's getDashboardInsights) and the admin Socket.IO push
 * (adminHandlers.ts's emitAdminInsightUpdate). Previously these were two
 * independent, drifted implementations; see the plan doc's "Bug D".
 *
 * Correctness fixes applied here relative to the old getDashboardInsights:
 * - Every stat previously built by `$unwind: '$participants'` (Bug A —
 *   Room.participants is never populated) now derives from
 *   getLiveUserCountsForRooms (Redis-backed, cross-instance accurate).
 * - Every "lifetime"/"today" stat sourced from Room/Message documents —
 *   which both have TTL indexes and get hard-deleted (Bug E) — now reads a
 *   durable counter from dailyStatsService/globalStats instead of live-
 *   querying documents that may already be gone.
 * - vanishedByAdmin/vanishedByAuto (previously ~always wrong — Bug F, only
 *   one of four room-teardown paths ever set the field they were grouped
 *   by) now read the dedicated per-cause counters.
 * - Day boundaries are UTC everywhere (previously local-time in one query
 *   and UTC in the chart bucketing of the same function — an internal
 *   inconsistency, independent of the REST/socket drift).
 */

export interface ChartDataPoint {
  date: string;
  count: number;
}

export interface AdminInsightsBundle {
  // Overview
  totalRooms: number;
  activeRooms: number;
  lockedRooms: number;
  autoVanishRooms: number;
  usersOnline: number;
  messagesSentToday: number;
  filesSharedToday: number;
  storageUsedToday: number; // MB

  // Rooms
  roomsCreatedToday: number;
  roomsCreatedChart: ChartDataPoint[];
  roomsCurrentlyActive: number;
  roomsLocked: number;
  roomsInAutoVanishCountdown: number;
  roomsEligibleToVanishNow: number;
  vanishedByAdmin: number;
  vanishedByAuto: number;
  averageRoomLifetime: number; // hours

  // User Status
  usersActiveToday: number;
  peakConcurrentUsersToday: number;
  usersInActiveRooms: number;
  usersInLockedRooms: number;
  usersInAutoVanishRooms: number;

  // User Growth
  usersJoinedToday: number;
  usersJoinedYesterday: number;
  usersJoinedChart: ChartDataPoint[];
  totalUniqueUsersLifetime: number;
  totalUserVisitsLifetime: number;
  totalUserVisitsToday: number;

  // Engagement
  averageUsersPerRoom: number;
  usersWhoSentMessageToday: number;
  silentUsersToday: number;
  averageSessionDuration: number; // minutes

  // System Signals
  reconnectAttempts: number;
  failedJoinAttempts: number;
  usersBlockedLockedVanished: number;

  // Messages
  messagesChart: ChartDataPoint[];
  peakMessagingTimeToday: string;

  // Files
  averageFileSize: number; // MB
  mostCommonFileType: string;

  // Storage Usage Insights
  totalStorageUsed: number; // MB
  storageUsedLast30Days: number; // MB
  storageByRoomStatus: {
    active: number;
    locked: number;
    'auto-vanish': number;
    ended: number;
    expired: number;
  };
  storagePerRoomTop: Array<{
    roomCode: string;
    roomName: string;
    totalSize: number;
    fileCount: number;
    isLocked: boolean;
    isEnded: boolean;
  }>;

  // System
  socketConnectionsLive: number;
  failedRoomJoins: number;
  uploadFailuresToday: number;
  uploadsGcsToday: number;
  uploadsLocalToday: number;
  gcsFallbackRate: number;
  uploadSuccessRate: number;
  autoVanishJobsRunning: number;

  // Legacy fields for backward compatibility
  vanishedToday: number;
  roomsExpiringInNextHour: number;
  roomsExpiringToday: number;
  timestamp: string;
}

const MB = 1024 * 1024;

/**
 * Fills gaps in an already-day-aggregated Mongo result (`[{_id: 'YYYY-MM-DD', count}]`)
 * so every day in the window is present. Only `usersJoinedChart` still needs this —
 * every other chart now comes pre-filled from dailyStatsService's Redis series.
 */
const fillPreAggregatedSeries = (
  startDate: Date,
  endDate: Date,
  data: Array<{ _id: string; count: number }>
): ChartDataPoint[] => {
  const dataMap = new Map<string, number>(data.map((d) => [d._id, d.count]));
  const result: ChartDataPoint[] = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const dateKey = cursor.toISOString().split('T')[0];
    result.push({ date: dateKey, count: dataMap.get(dateKey) || 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
};

export const computeDashboardInsights = async (): Promise<AdminInsightsBundle> => {
  // UTC throughout — Cloud Run containers run UTC by default, and this
  // fixes a pre-existing internal inconsistency where "today" (local time)
  // and the 30-day chart bucketing (UTC) disagreed with each other.
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const yesterdayStart = new Date(startOfDay);
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
  const yesterdayEnd = new Date(startOfDay);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const io = getIoInstance();

  // ---- Rooms: live document lists (also feed the live-count lookups below) ----
  const [
    activeRoomDocs,
    lockedRoomDocs,
    autoVanishRoomDocs,
    roomsExpiringNextHour,
    roomsExpiringToday,
    roomsEligibleToVanishNow,
    averageRoomLifetime,
    totalRoomsLifetime,
  ] = await Promise.all([
    RoomModel.find({ expiresAt: { $gt: now }, isEnded: { $ne: true }, isLocked: { $ne: true } })
      .select('code').lean().exec(),
    RoomModel.find({ isLocked: true, isEnded: { $ne: true } }).select('code').lean().exec(),
    RoomModel.find({ expiresAt: { $gt: now, $lt: tomorrow }, isLocked: true, isEnded: { $ne: true } })
      .select('code').lean().exec(),
    RoomModel.countDocuments({ expiresAt: { $gte: now, $lte: oneHourFromNow }, isEnded: { $ne: true } }),
    RoomModel.countDocuments({ expiresAt: { $gte: startOfDay, $lte: endOfDay }, isEnded: { $ne: true } }),
    RoomModel.countDocuments({
      isLocked: true,
      lockedAt: { $exists: true, $lt: oneDayAgo },
      isEnded: { $ne: true },
      expiresAt: { $gt: now },
    }),
    // Low-priority metric (Bug F-adjacent): scoped to the rare isEnded:true
    // sliver (owner-initiated ends only — admin/auto vanishes delete the
    // room directly and never set isEnded). Left live rather than building
    // dedicated counter machinery for a secondary metric.
    RoomModel.aggregate([
      { $match: { isEnded: true, endedAt: { $gte: thirtyDaysAgo } } },
      { $project: { lifetime: { $subtract: ['$endedAt', '$createdAt'] } } },
      { $group: { _id: null, avgLifetime: { $avg: '$lifetime' } } },
    ]).allowDiskUse(true),
    getSelfHealingGlobalStat('totalRoomsLifetime', () => RoomModel.estimatedDocumentCount()),
  ]);

  const activeRoomCodes = activeRoomDocs.map((r: any) => r.code);
  const lockedRoomCodes = lockedRoomDocs.map((r: any) => r.code);
  const autoVanishRoomCodes = autoVanishRoomDocs.map((r: any) => r.code);
  const allTrackedRoomCodes = Array.from(new Set([...activeRoomCodes, ...lockedRoomCodes, ...autoVanishRoomCodes]));

  // One pipelined Redis round trip covers every room's live user count —
  // replaces four separate broken `$unwind: '$participants'` aggregates
  // (Bug A) plus the Active/Locked Rooms table's own per-room lookups.
  const liveCounts = await getLiveUserCountsForRooms(io, allTrackedRoomCodes);
  const usersInActiveRooms = sumLiveUserCounts(liveCounts, activeRoomCodes);
  const usersInLockedRooms = sumLiveUserCounts(liveCounts, lockedRoomCodes);
  const usersInAutoVanishRooms = sumLiveUserCounts(liveCounts, autoVanishRoomCodes);
  const averageUsersPerRoom = activeRoomCodes.length > 0 ? usersInActiveRooms / activeRoomCodes.length : 0;

  const [{ admin: vanishedByAdminRaw, auto: vanishedByAuto, owner: vanishedByOwnerRaw }, roomsCreatedSeries] =
    await Promise.all([getRoomsVanishedTodayByCause(), getRoomsCreatedSeries()]);
  const vanishedByAdmin = vanishedByAdminRaw + vanishedByOwnerRaw;
  const vanishedToday = vanishedByAdminRaw + vanishedByAuto + vanishedByOwnerRaw;
  const roomsCreatedToday = roomsCreatedSeries[roomsCreatedSeries.length - 1]?.count || 0;

  // ---- Messages / Files / Storage: durable day-keyed counters ----
  const [
    messagesSentSeries,
    filesSharedToday,
    storageBytesToday,
    storageBytesSeries,
    peakMessagingHour,
    totalStorageUsed,
    storageByRoomStatusRaw,
    storagePerRoomTopRaw,
  ] = await Promise.all([
    getMessagesSentSeries(),
    getFilesSharedToday(),
    getStorageBytesToday(),
    getStorageBytesSeries(),
    getPeakMessagingHourToday(),
    // Kept live: this is inherently "storage currently tracked by
    // non-expired rooms' message docs" (a live snapshot), not a cumulative
    // total that a counter could represent unambiguously.
    MessageModel.aggregate([
      { $match: { type: 'file', deletedByAdmin: { $ne: true }, 'fileMeta.size': { $exists: true, $gt: 0 } } },
      { $group: { _id: null, totalSize: { $sum: '$fileMeta.size' } } },
    ]).allowDiskUse(true),
    MessageModel.aggregate([
      { $match: { type: 'file', deletedByAdmin: { $ne: true }, 'fileMeta.size': { $exists: true, $gt: 0 } } },
      { $lookup: { from: 'rooms', localField: 'roomCode', foreignField: 'code', as: 'room' } },
      { $unwind: { path: '$room', preserveNullAndEmptyArrays: true } },
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
                          { $gt: ['$room.expiresAt', now] },
                        ],
                      },
                      'auto-vanish',
                      'locked',
                    ],
                  },
                  { $cond: [{ $gt: ['$room.expiresAt', now] }, 'active', 'expired'] },
                ],
              },
            ],
          },
        },
      },
      { $group: { _id: '$roomStatus', totalSize: { $sum: '$size' } } },
    ]).allowDiskUse(true),
    MessageModel.aggregate([
      { $match: { type: 'file', deletedByAdmin: { $ne: true }, 'fileMeta.size': { $exists: true, $gt: 0 } } },
      { $group: { _id: '$roomCode', totalSize: { $sum: '$fileMeta.size' }, fileCount: { $sum: 1 } } },
      { $lookup: { from: 'rooms', localField: '_id', foreignField: 'code', as: 'room' } },
      { $unwind: { path: '$room', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          roomCode: '$_id',
          totalSize: 1,
          fileCount: 1,
          roomName: { $ifNull: ['$room.name', 'Unknown'] },
          isLocked: { $ifNull: ['$room.isLocked', false] },
          isEnded: { $ifNull: ['$room.isEnded', false] },
        },
      },
      { $sort: { totalSize: -1 } },
      { $limit: 50 },
    ]).allowDiskUse(true),
  ]);

  const messagesSentToday = messagesSentSeries[messagesSentSeries.length - 1]?.count || 0;
  const storageUsedLast30Days = storageBytesSeries.reduce((sum, d) => sum + d.count, 0) / MB;

  // Avg file size / most common type today are low-traffic display fields —
  // kept as a small live aggregate rather than adding two more counter
  // families for one card each.
  const fileStatsToday = await MessageModel.aggregate([
    {
      $match: {
        type: 'file',
        createdAt: { $gte: startOfDay, $lte: endOfDay },
        deletedByAdmin: { $ne: true },
        'fileMeta.mimeType': { $exists: true },
      },
    },
    { $group: { _id: '$fileMeta.mimeType', count: { $sum: 1 }, avgSize: { $avg: '$fileMeta.size' } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]).allowDiskUse(true);

  // ---- User Growth: UserVisit has no TTL index, so live aggregates here are correct (just optimized for cost where cheap to do so) ----
  const [
    usersJoinedTodayIds,
    usersJoinedYesterday,
    usersJoinedLast30Days,
    totalUniqueUsersLifetime,
    totalUserVisitsLifetime,
    totalUserVisitsToday,
  ] = await Promise.all([
    UserVisitModel.distinct('userId', { joinedAt: { $gte: startOfDay, $lte: endOfDay } }),
    UserVisitModel.aggregate([
      { $match: { joinedAt: { $gte: yesterdayStart, $lte: yesterdayEnd } } },
      { $group: { _id: '$userId' } },
      { $count: 'count' },
    ]).allowDiskUse(true),
    UserVisitModel.aggregate([
      { $match: { joinedAt: { $gte: thirtyDaysAgo, $lte: now } } },
      { $project: { userId: 1, date: { $dateToString: { format: '%Y-%m-%d', date: '$joinedAt' } } } },
      { $group: { _id: { date: '$date', userId: '$userId' } } },
      { $group: { _id: '$_id.date', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).allowDiskUse(true),
    // O(1) SCARD, self-healed once from a live distinct-aggregate — replaces
    // an unbounded full-collection distinct scan that got slower forever.
    getUniqueUsersLifetimeCount(),
    getSelfHealingGlobalStat('totalVisitsLifetime', () => UserVisitModel.countDocuments({})),
    UserVisitModel.countDocuments({ joinedAt: { $gte: startOfDay, $lte: endOfDay } }),
  ]);

  const usersJoinedToday = usersJoinedTodayIds.length;
  const usersJoinedChart = fillPreAggregatedSeries(
    thirtyDaysAgo,
    now,
    Array.isArray(usersJoinedLast30Days) ? usersJoinedLast30Days : []
  );

  // ---- Engagement ----
  const [messageSendersCountToday, messageSenderIdsToday] = await Promise.all([
    getMessageSendersCountToday(),
    getMessageSenderIdsToday(),
  ]);
  const senderIdSet = new Set(messageSenderIdsToday);
  const silentUsersToday = usersJoinedTodayIds.filter((id: string) => !senderIdSet.has(id)).length;

  // Low-priority metric (same isEnded:true sample-bias caveat as
  // averageRoomLifetime above) — left live.
  const averageSessionDuration = await RoomModel.aggregate([
    { $match: { isEnded: true, endedAt: { $gte: thirtyDaysAgo } } },
    {
      $lookup: {
        from: 'messages',
        let: { roomCode: '$code' },
        pipeline: [
          { $match: { $expr: { $eq: ['$roomCode', '$$roomCode'] }, deletedByAdmin: { $ne: true } } },
          { $sort: { createdAt: -1 } },
          { $limit: 1 },
          { $project: { lastMessageTime: '$createdAt' } },
        ],
        as: 'lastMessage',
      },
    },
    {
      $project: {
        sessionDuration: {
          $subtract: [{ $ifNull: [{ $arrayElemAt: ['$lastMessage.lastMessageTime', 0] }, '$endedAt'] }, '$createdAt'],
        },
      },
    },
    { $match: { sessionDuration: { $gt: 0 } } },
    { $group: { _id: null, avgDuration: { $avg: '$sessionDuration' } } },
  ]).allowDiskUse(true).catch(() => []);

  // ---- System Signals / System (unchanged — already cheap, in-memory) ----
  const { getTodayMetrics } = await import('./platformMetricsService.js');
  const platformMetrics = getTodayMetrics();
  // Raw connection count — a separate, intentionally "technical" metric from
  // usersOnline below (includes ghost/admin sockets and multi-tab duplicates,
  // and only reflects this one instance). Shown on the dashboard as its own
  // card; don't conflate the two.
  const socketConnectionsLive = io ? io.sockets.sockets.size : 0;
  // Ghost-excluded, deduped-by-user, cross-instance-accurate — see
  // getPlatformUsersOnline's doc comment for why this replaced the previous
  // io.sockets.sockets.size-based formula (it double-counted multi-tab users,
  // counted Ghost Mode admins and the admin dashboard's own sockets, and only
  // reflected whichever single instance handled the request).
  const usersOnline = await getPlatformUsersOnline();
  const peakConcurrentUsersToday = await getPeakConcurrentToday();

  return {
    // Overview
    totalRooms: totalRoomsLifetime || 0,
    activeRooms: activeRoomCodes.length,
    lockedRooms: lockedRoomCodes.length,
    autoVanishRooms: autoVanishRoomCodes.length,
    usersOnline: usersOnline || 0,
    messagesSentToday,
    filesSharedToday,
    storageUsedToday: storageBytesToday / MB,

    // Rooms
    roomsCreatedToday,
    roomsCreatedChart: roomsCreatedSeries,
    roomsCurrentlyActive: activeRoomCodes.length,
    roomsLocked: lockedRoomCodes.length,
    roomsInAutoVanishCountdown: autoVanishRoomCodes.length,
    roomsEligibleToVanishNow: roomsEligibleToVanishNow || 0,
    vanishedByAdmin,
    vanishedByAuto,
    averageRoomLifetime: averageRoomLifetime[0]?.avgLifetime ? averageRoomLifetime[0].avgLifetime / (1000 * 60 * 60) : 0,

    // User Status
    usersActiveToday: usersJoinedToday, // previously a separate (Bug A-broken) query duplicating this exact metric
    peakConcurrentUsersToday,
    usersInActiveRooms,
    usersInLockedRooms,
    usersInAutoVanishRooms,

    // User Growth
    usersJoinedToday,
    usersJoinedYesterday: usersJoinedYesterday[0]?.count || 0,
    usersJoinedChart,
    totalUniqueUsersLifetime,
    totalUserVisitsLifetime: totalUserVisitsLifetime || 0,
    totalUserVisitsToday: totalUserVisitsToday || 0,

    // Engagement
    averageUsersPerRoom,
    usersWhoSentMessageToday: messageSendersCountToday,
    silentUsersToday,
    averageSessionDuration: averageSessionDuration[0]?.avgDuration ? averageSessionDuration[0].avgDuration / (1000 * 60) : 0,

    // System Signals
    reconnectAttempts: platformMetrics.reconnectAttempts || 0,
    failedJoinAttempts: platformMetrics.failedJoinAttempts || 0,
    usersBlockedLockedVanished: platformMetrics.usersBlockedLockedVanished || 0,

    // Messages
    messagesChart: messagesSentSeries,
    peakMessagingTimeToday: peakMessagingHour !== null ? `${peakMessagingHour}:00` : 'N/A',

    // Files
    averageFileSize: fileStatsToday[0]?.avgSize ? fileStatsToday[0].avgSize / MB : 0,
    mostCommonFileType: fileStatsToday[0]?._id || 'N/A',

    // Storage Usage Insights
    totalStorageUsed: (totalStorageUsed[0]?.totalSize || 0) / MB,
    storageUsedLast30Days,
    storageByRoomStatus: {
      active: (storageByRoomStatusRaw.find((s: any) => s._id === 'active')?.totalSize || 0) / MB,
      locked: (storageByRoomStatusRaw.find((s: any) => s._id === 'locked')?.totalSize || 0) / MB,
      'auto-vanish': (storageByRoomStatusRaw.find((s: any) => s._id === 'auto-vanish')?.totalSize || 0) / MB,
      ended: (storageByRoomStatusRaw.find((s: any) => s._id === 'ended')?.totalSize || 0) / MB,
      expired: (storageByRoomStatusRaw.find((s: any) => s._id === 'expired')?.totalSize || 0) / MB,
    },
    storagePerRoomTop: storagePerRoomTopRaw.map((room: any) => ({
      roomCode: room.roomCode,
      roomName: room.roomName,
      totalSize: room.totalSize / MB,
      fileCount: room.fileCount,
      isLocked: room.isLocked,
      isEnded: room.isEnded,
    })),

    // System
    socketConnectionsLive: socketConnectionsLive || 0,
    failedRoomJoins: platformMetrics.failedRoomJoins || 0,
    uploadFailuresToday: platformMetrics.uploadFailures,
    uploadsGcsToday: platformMetrics.uploadsGcs,
    uploadsLocalToday: platformMetrics.uploadsLocal,
    gcsFallbackRate: platformMetrics.gcsFallbackRate,
    uploadSuccessRate: platformMetrics.uploadSuccessRate,
    autoVanishJobsRunning: 1,

    // Legacy fields for backward compatibility
    vanishedToday,
    roomsExpiringInNextHour: roomsExpiringNextHour,
    roomsExpiringToday,
    timestamp: new Date().toISOString(),
  };
};

// ---- Single-flight, short-TTL cache ----
// Coalesces concurrent callers (REST poll + socket heartbeat + event-driven
// push, potentially all within the same second) into one computation,
// replacing the old adminHandlers.ts "mutex" that only staggered retries
// rather than actually deduplicating them.

let cache: { data: AdminInsightsBundle; at: number } | null = null;
let inFlight: Promise<AdminInsightsBundle> | null = null;
const CACHE_TTL_MS = 10_000;

export const getDashboardInsightsCached = async (force = false): Promise<AdminInsightsBundle> => {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inFlight) return inFlight;

  inFlight = computeDashboardInsights()
    .then((data) => {
      cache = { data, at: Date.now() };
      return data;
    })
    .catch((error: unknown) => {
      logger.error('Failed to compute dashboard insights', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

// Exposed for anywhere that only needs a single already-known-cheap counter
// (e.g. future lightweight endpoints) without pulling in the full bundle.
export { getOrCreateGlobalStat };
