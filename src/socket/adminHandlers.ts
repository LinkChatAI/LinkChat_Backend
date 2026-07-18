import { Server, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { invalidateDashboardCache } from '../middleware/adminCache.js';
import { getDashboardInsightsCached } from '../services/adminInsightsService.js';

const ADMIN_ROOM = 'admin:insights';
const getRedis = () => getRedisClient();

// ── Admin presence & insights cache ──────────────────────────────────────────
// emitAdminInsightUpdate fires on EVERY message/join/leave/file event, and
// getDashboardInsightsCached() (adminInsightsService.ts) runs ~15-20 MongoDB
// aggregations on a cache miss. Without gating, that work happens even when
// no admin dashboard is open — by far the largest avoidable database load in
// the app. The actual insights computation and its short-TTL cache now live
// in adminInsightsService.ts, shared with the REST /insights/dashboard
// endpoint — this file previously had its own ~950-line duplicate of that
// computation plus a separate cache, which had drifted out of sync with the
// REST version (see plan doc "Bug D").

// Cross-instance presence flag: the local adapter room only knows about admins
// connected to THIS instance; an admin may be watching from another one.
const ADMIN_PRESENCE_KEY = 'admin:presence';
const ADMIN_PRESENCE_TTL_S = 90; // refreshed by the periodic updater; expires after crashes

const refreshAdminPresence = async (): Promise<void> => {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.setex(ADMIN_PRESENCE_KEY, ADMIN_PRESENCE_TTL_S, '1');
    } catch { /* non-critical */ }
  }
};

const clearAdminPresence = async (): Promise<void> => {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.del(ADMIN_PRESENCE_KEY);
    } catch { /* non-critical */ }
  }
};

const isAnyAdminConnected = async (io: Server): Promise<boolean> => {
  const localRoom = io.sockets.adapter.rooms.get(ADMIN_ROOM);
  if (localRoom && localRoom.size > 0) return true;
  // An O(1) Redis check per event is cheap next to the aggregations it guards.
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      return (await redis.exists(ADMIN_PRESENCE_KEY)) === 1;
    } catch {
      return false;
    }
  }
  return false;
};

// Emit insight update to all admin clients
export const emitAdminInsightUpdate = async (io: Server, event: string, data?: any): Promise<void> => {
  try {
    // Nobody watching → skip the aggregations (and the cache invalidation).
    // The REST dashboard cache has its own TTL, so it self-heals even
    // without event-driven invalidation.
    if (!(await isAnyAdminConnected(io))) return;

    // Invalidate the REST HTTP cache (dashboard + Active/Locked Rooms lists)
    // so the next poll/tab-switch sees fresh data instead of waiting out
    // its TTL.
    await invalidateDashboardCache();

    const insights = await getDashboardInsightsCached();
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

// Periodic update interval for real-time stats (every 7 seconds)
let periodicUpdateInterval: NodeJS.Timeout | null = null;
const UPDATE_INTERVAL_MS = 7000; // 7 seconds (between 5-10 seconds as requested)

/**
 * Start periodic real-time updates for all admin clients
 */
export const startPeriodicAdminUpdates = (io: Server): void => {
  if (periodicUpdateInterval) {
    return; // Already running
  }

  periodicUpdateInterval = setInterval(async () => {
    try {
      // Keep the cross-instance presence flag alive while admins are connected
      await refreshAdminPresence();

      // Get real-time users online from Socket.IO
      const usersOnline = io ? (io.engine?.clientsCount || io.sockets.sockets.size || 0) : 0;

      // Emit lightweight real-time update (only usersOnline, not full insights)
      io.to(ADMIN_ROOM).emit('admin:stats_update', {
        usersOnline,
        socketConnectionsLive: usersOnline,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      logger.warn('Error in periodic admin update', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, UPDATE_INTERVAL_MS);

  logger.info('Started periodic admin stats updates', { intervalMs: UPDATE_INTERVAL_MS });
};

/**
 * Stop periodic updates
 */
export const stopPeriodicAdminUpdates = (): void => {
  if (periodicUpdateInterval) {
    clearInterval(periodicUpdateInterval);
    periodicUpdateInterval = null;
    logger.info('Stopped periodic admin stats updates');
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

  // Start periodic updates if not already running
  startPeriodicAdminUpdates(io);
  void refreshAdminPresence();

  // Join admin room
  socket.join(ADMIN_ROOM);

  // Send initial insights on connection (rehydration)
  getDashboardInsightsCached()
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
    // Stop the 7s interval when the last local admin leaves. Previously it
    // ran for the life of the instance, emitting into an empty room forever.
    const adminRoom = io.sockets.adapter.rooms.get(ADMIN_ROOM);
    if (!adminRoom || adminRoom.size === 0) {
      stopPeriodicAdminUpdates();
      void clearAdminPresence();
    }
  });

  // Handle manual refresh request — explicit refresh bypasses the cache
  socket.on('admin:refresh_insights', async () => {
    try {
      const insights = await getDashboardInsightsCached(true);
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
