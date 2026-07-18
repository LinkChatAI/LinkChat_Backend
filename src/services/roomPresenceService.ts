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
