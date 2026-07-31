import { Server } from 'socket.io';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { getCachedRoomSocketCount } from '../socket/handlers/socketCache.js';
import { logger } from '../utils/logger.js';

const getRedis = () => getRedisClient();

/**
 * Cross-instance-accurate live participant counts for a batch of rooms, in
 * one round trip. Replaces the admin dashboard's old per-room, per-request
 * logic that trusted the *local* Socket.IO adapter first (wrong on a
 * multi-instance Cloud Run deployment — an admin request can land on an
 * instance that never saw that room's last join/leave) and fell back to the
 * always-empty `Room.participants` field as a last resort.
 *
 * Primary source: Redis `SCARD room:{code}:users`, pipelined for every room
 * in one call — this is the same source `joinHandlers.ts`/
 * `roomLifecycleHandlers.ts` already treat as authoritative for their own
 * broadcasts. Falls back to `getCachedRoomSocketCount` (cross-instance via
 * the Socket.IO Redis adapter, already excludes ghost-mode admin sockets)
 * only for rooms Redis couldn't answer for.
 */
export const getLiveUserCountsForRooms = async (
  io: Server | null,
  roomCodes: string[]
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  if (roomCodes.length === 0) return counts;

  const redis = getRedis();
  const misses: string[] = [];

  if (redis && isRedisAvailable()) {
    try {
      const pipeline = redis.pipeline();
      roomCodes.forEach((code) => pipeline.scard(`room:${code}:users`));
      const results = await pipeline.exec();
      results?.forEach((result: [Error | null, unknown], i: number) => {
        const [err, value] = result;
        if (err || typeof value !== 'number') {
          misses.push(roomCodes[i]);
        } else {
          counts.set(roomCodes[i], value);
        }
      });
    } catch (error: unknown) {
      logger.warn('Redis pipeline failed for live room user counts, falling back for all rooms', {
        error: error instanceof Error ? error.message : String(error),
      });
      misses.push(...roomCodes);
    }
  } else {
    misses.push(...roomCodes);
  }

  if (misses.length > 0 && io) {
    await Promise.all(
      misses.map(async (code) => {
        try {
          counts.set(code, await getCachedRoomSocketCount(io, code));
        } catch {
          counts.set(code, 0);
        }
      })
    );
  } else {
    misses.forEach((code) => {
      if (!counts.has(code)) counts.set(code, 0);
    });
  }

  return counts;
};

/** Sum of live counts across a set of room codes — for "users in active/locked/auto-vanish rooms". */
export const sumLiveUserCounts = (counts: Map<string, number>, roomCodes: string[]): number =>
  roomCodes.reduce((total, code) => total + (counts.get(code) || 0), 0);

/**
 * Platform-wide count of unique real users currently connected to any room,
 * across every Cloud Run instance. The single correct source for admin
 * dashboard "users online" stats — do not recompute this from
 * `io.sockets.sockets.size` / `io.engine.clientsCount` elsewhere:
 *
 *  - Ghost Mode admins are excluded for free — they're never added to a
 *    `room:{code}:users` set (see joinHandlers.ts), so no separate filtering
 *    is needed.
 *  - Deduped by userId, not by socket — a user with two tabs open still
 *    counts once.
 *  - Cross-instance accurate via Redis, unlike `io.sockets`/`io.engine`,
 *    which only reflect connections to whichever single instance handled
 *    the request.
 *  - Also excludes the admin dashboard's own socket connections (they join
 *    an admin room, never a `room:{code}:users` set).
 *
 * Uses a non-blocking SCAN (not KEYS, which blocks Redis's single-threaded
 * event loop for every other caller — including the join/leave hot path —
 * for the duration of the scan) plus a pipelined SMEMBERS batch.
 */
export const getPlatformUsersOnline = async (): Promise<number> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return 0;

  try {
    const keys: string[] = [];
    const stream = redis.scanStream({ match: 'room:*:users', count: 100 });
    for await (const chunk of stream as AsyncIterable<string[]>) {
      keys.push(...chunk);
    }
    if (keys.length === 0) return 0;

    const pipeline = redis.pipeline();
    keys.forEach((key) => pipeline.smembers(key));
    const results = await pipeline.exec();

    const userIds = new Set<string>();
    results?.forEach((result: [Error | null, unknown]) => {
      const [, members] = result;
      (members as string[] | undefined)?.forEach((userId) => userIds.add(userId));
    });
    return userIds.size;
  } catch (error: unknown) {
    logger.warn('getPlatformUsersOnline: Redis scan failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
};
