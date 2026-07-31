import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { RoomBannerAssignmentModel } from '../models/RoomBannerAssignment.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { deleteRoomFiles } from './gcsService.js';
import { clearInMemoryRoomState } from './roomPurgeService.js';
import { logger } from '../utils/logger.js';

/**
 * Reconciles resources whose owning Room no longer exists.
 *
 * Two things produce these orphans:
 *   1. The legacy TTL index on Room.expiresAt, which deleted room documents
 *      inside mongod without running any cleanup code. Every room that expired
 *      before that index was removed left its files, Redis keys and messages
 *      behind. This job is what clears that historical backlog.
 *   2. A purge that partially failed — purgeRoom is fault-isolated per step, so
 *      a GCS or Redis outage can leave one resource type behind on purpose
 *      rather than aborting the whole teardown.
 *
 * Everything here is verified against Mongo immediately before deletion: a
 * resource is only removed when its room code has NO Room document at all.
 */

/** Bounds a single run so a large backlog can't monopolize the instance. */
const MAX_CODES_PER_RUN = parseInt(process.env.RECONCILE_MAX_CODES || '500', 10);

export interface ReconcileResult {
  redisRoomsPurged: number;
  redisKeysDeleted: number;
  orphanedMessagesDeleted: number;
  orphanedBannerAssignmentsDeleted: number;
  orphanedFileRoomsPurged: number;
  scannedCodes: number;
  truncated: boolean;
  errors: string[];
}

/**
 * Which of these codes have no Room document. Chunked because `$in` with
 * thousands of terms is both slow and can exceed the BSON document limit.
 */
const findOrphanedCodes = async (codes: string[]): Promise<Set<string>> => {
  const orphaned = new Set(codes);
  const CHUNK = 500;

  for (let i = 0; i < codes.length; i += CHUNK) {
    const chunk = codes.slice(i, i + CHUNK);
    const existing = await RoomModel.find({ code: { $in: chunk } })
      .select('code')
      .lean()
      .exec();
    for (const room of existing) {
      orphaned.delete(room.code);
    }
  }

  return orphaned;
};

/**
 * SCAN (never KEYS — KEYS is O(keyspace) and blocks the whole Redis server)
 * for room-scoped keys, and delete the ones whose room is gone.
 */
const reconcileRedis = async (
  result: ReconcileResult,
): Promise<void> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return;

  const codes = new Set<string>();

  try {
    for (const pattern of ['room:*:users', 'room:*:nicknames']) {
      const stream = redis.scanStream({ match: pattern, count: 200 });
      for await (const batch of stream as AsyncIterable<string[]>) {
        for (const key of batch) {
          const code = key.split(':')[1];
          if (code) codes.add(code);
        }
        if (codes.size >= MAX_CODES_PER_RUN) {
          result.truncated = true;
          stream.destroy();
          break;
        }
      }
    }
  } catch (error) {
    result.errors.push(
      `redis-scan: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (codes.size === 0) return;

  const orphaned = await findOrphanedCodes([...codes]);

  for (const code of orphaned) {
    try {
      // Resolve user hashes through the room's own member set before deleting
      // it, and only drop a hash that still points at this dead room.
      const memberIds: string[] = await redis.smembers(`room:${code}:users`);
      const owned: string[] = [];

      if (memberIds.length > 0) {
        const pipeline = redis.pipeline();
        memberIds.forEach((uid: string) => pipeline.hget(`user:${uid}`, 'roomCode'));
        const hits = await pipeline.exec();
        memberIds.forEach((uid: string, i: number) => {
          const [err, value] = hits?.[i] ?? [null, null];
          if (!err && value === code) owned.push(`user:${uid}`);
        });
      }

      const deleted = await redis.del(
        `room:${code}:users`,
        `room:${code}:nicknames`,
        ...owned,
      );

      result.redisKeysDeleted += deleted;
      result.redisRoomsPurged++;

      // This instance's own Maps may still hold the dead code too.
      clearInMemoryRoomState(code);
    } catch (error) {
      result.errors.push(
        `redis-purge ${code}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

/**
 * Messages whose room is gone. These survive today because Message.expiresAt
 * is optional — a message created while the room lookup failed gets no TTL and
 * is otherwise immortal.
 */
const reconcileMessages = async (result: ReconcileResult): Promise<void> => {
  try {
    const codes: string[] = await MessageModel.distinct('roomCode');
    result.scannedCodes += codes.length;

    if (codes.length === 0) return;

    const capped = codes.slice(0, MAX_CODES_PER_RUN);
    if (capped.length < codes.length) result.truncated = true;

    const orphaned = await findOrphanedCodes(capped);
    if (orphaned.size === 0) return;

    const deleteResult = await MessageModel.deleteMany({ roomCode: { $in: [...orphaned] } });
    result.orphanedMessagesDeleted = deleteResult.deletedCount ?? 0;

    // Files are addressed by room prefix, so an orphaned message set means the
    // room's objects are very likely orphaned too.
    for (const code of orphaned) {
      try {
        const files = await deleteRoomFiles(code);
        if (files.gcs > 0) result.orphanedFileRoomsPurged++;
      } catch (error) {
        result.errors.push(
          `files ${code}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      clearInMemoryRoomState(code);
    }
  } catch (error) {
    result.errors.push(
      `messages: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const reconcileBannerAssignments = async (result: ReconcileResult): Promise<void> => {
  try {
    const codes: string[] = await RoomBannerAssignmentModel.distinct('roomCode');
    if (codes.length === 0) return;

    const orphaned = await findOrphanedCodes(codes.slice(0, MAX_CODES_PER_RUN));
    if (orphaned.size === 0) return;

    const deleteResult = await RoomBannerAssignmentModel.deleteMany({
      roomCode: { $in: [...orphaned] },
    });
    result.orphanedBannerAssignmentsDeleted = deleteResult.deletedCount ?? 0;
  } catch (error) {
    result.errors.push(
      `bannerAssignments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const reconcileOrphanedRoomData = async (): Promise<ReconcileResult> => {
  const result: ReconcileResult = {
    redisRoomsPurged: 0,
    redisKeysDeleted: 0,
    orphanedMessagesDeleted: 0,
    orphanedBannerAssignmentsDeleted: 0,
    orphanedFileRoomsPurged: 0,
    scannedCodes: 0,
    truncated: false,
    errors: [],
  };

  if (mongoose.connection.readyState !== 1) {
    result.errors.push('mongo: not connected');
    return result;
  }

  await reconcileRedis(result);
  await reconcileMessages(result);
  await reconcileBannerAssignments(result);

  logger.info('Reconciled orphaned room data', { ...result, errors: result.errors.length });
  if (result.errors.length > 0) {
    logger.warn('Reconciliation completed with errors', { errors: result.errors });
  }
  if (result.truncated) {
    logger.warn('Reconciliation hit its per-run cap; run again to continue', {
      cap: MAX_CODES_PER_RUN,
    });
  }

  return result;
};
