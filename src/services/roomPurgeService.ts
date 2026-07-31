import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { RoomBannerAssignmentModel } from '../models/RoomBannerAssignment.js';
import { UserVisitModel } from '../models/UserVisit.js';
import { UserModel } from '../models/User.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { deleteRoomFiles } from './gcsService.js';
import { logger } from '../utils/logger.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { invalidateRoomCache } from './roomService.js';
import { clearRoomModeration } from './roomModerationService.js';
import { clearSlowModeForRoom } from './slowModeService.js';
import { clearRoomReceipts } from './readReceiptService.js';
import { removeRoomMetrics } from './metricsService.js';
import { clearScreenShareState } from '../socket/screenShareState.js';
import { clearRoomSocketCache } from '../socket/handlers/socketCache.js';
import { clearAllTimersForRoom } from '../socket/handlers/roomTimers.js';

/**
 * The single canonical room teardown.
 *
 * Before this existed there were eight independent delete implementations
 * (expiry cron, auto-vanish, admin vanish, REST delete, and four socket
 * handlers), each clearing a different subset of state. Every one of them now
 * routes here so there is exactly one definition of "the room is gone".
 *
 * Ordering is deliberate and load-bearing:
 *   1. mark purging   — so concurrent joins/disconnects don't recreate state
 *   2. notify clients — while their sockets are still attached
 *   3. collect userIds — from BOTH sockets and Redis, before either is torn down
 *   4. disconnect     — evict everyone from the room
 *   5. durable data   — files and Mongo documents
 *   6. Redis          — needs the userIds gathered in step 3
 *   7. in-memory      — last, so nothing repopulates behind the sweep
 *
 * Steps 5-7 are individually fault-isolated: a GCS outage must never leave the
 * Mongo documents or the Redis keys behind, so no step can abort the rest.
 */

export type PurgeTrigger =
  | 'expired'
  | 'auto-vanish'
  | 'admin'
  | 'owner'
  | 'host-grace-expired'
  | 'api';

/**
 * Maps a purge trigger onto the three buckets the daily stats track. Anything
 * the system decided on its own counts as 'auto'; only a deliberate human
 * action counts as 'owner' or 'admin'.
 */
const VANISH_CAUSE_BY_TRIGGER: Record<PurgeTrigger, 'admin' | 'auto' | 'owner'> = {
  expired: 'auto',
  'auto-vanish': 'auto',
  'host-grace-expired': 'auto',
  admin: 'admin',
  owner: 'owner',
  api: 'owner',
};

export interface PurgeRoomOptions {
  /** Human-readable reason sent to clients in the terminal event. */
  reason: string;
  /** What initiated the purge — drives logging and the stats counter. */
  trigger: PurgeTrigger;
  /**
   * Terminal event name. Different clients listen for different names for
   * historical reasons; callers keep their existing contract.
   */
  event?: 'room_vanished' | 'room_destroyed' | 'room_terminated';
  /** userId attributed in the terminal event payload. */
  actorId?: string;
  /** Optional system chat message broadcast before teardown begins. */
  systemMessage?: string;
  /**
   * Also delete this room's UserVisit rows. Default false: UserVisit backs
   * lifetime analytics (unique users, 7/30-day retention, session duration,
   * the geo map), so per-room deletion permanently skews those dashboards.
   * Enable via PURGE_USER_VISITS_ON_ROOM_DELETE only if room-scoped visit
   * data must not outlive the room.
   */
  purgeUserVisits?: boolean;
  /**
   * Whether to increment the daily rooms-vanished counter. Set false when the
   * caller already recorded it — roomService.endRoom counts the vanish at the
   * moment the host ends the room, so the deferred purge of that same room
   * must not count it a second time.
   */
  recordStat?: boolean;
}

export interface PurgeRoomResult {
  roomCode: string;
  roomDeleted: boolean;
  messagesDeleted: number;
  filesDeleted: number;
  bannerAssignmentsDeleted: number;
  userVisitsDeleted: number;
  savedRoomRefsPruned: number;
  socketsDisconnected: number;
  redisKeysDeleted: number;
  timersCancelled: number;
  errors: string[];
}

/**
 * Rooms currently mid-teardown. Socket disconnect handlers consult this so a
 * forced disconnect during purge doesn't register a 20-minute leave timer for
 * a room that no longer exists — those timers would otherwise fire against a
 * room code that has since been recycled to a different room.
 */
const purgingRooms = new Set<string>();

export const isRoomPurging = (roomCode: string): boolean => purgingRooms.has(roomCode);

const shouldPurgeUserVisitsByDefault = (): boolean =>
  String(process.env.PURGE_USER_VISITS_ON_ROOM_DELETE || '').toLowerCase() === 'true';

/**
 * Delete every Redis key scoped to a room.
 *
 * `room:{code}:users` doubles as the reverse index for `user:{uid}` hashes, so
 * it must be read before it is deleted. `room:{code}:nicknames` was previously
 * deleted by none of the eight paths — it survived on its 6h TTL alone, which
 * meant a recycled room code could inherit the previous tenant's reserved
 * nicknames.
 */
const purgeRedisForRoom = async (
  roomCode: string,
  extraUserIds: string[],
): Promise<{ deleted: number; error?: string }> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) {
    return { deleted: 0 };
  }

  try {
    const memberIds = await redis.smembers(`room:${roomCode}:users`);
    const userIds = [...new Set([...memberIds, ...extraUserIds])];

    // Only drop a user hash if it still points at THIS room — a user who has
    // already moved to another room must keep their current session.
    const owned: string[] = [];
    if (userIds.length > 0) {
      const pipeline = redis.pipeline();
      userIds.forEach((uid) => pipeline.hget(`user:${uid}`, 'roomCode'));
      const results = await pipeline.exec();
      userIds.forEach((uid, i) => {
        const [err, value] = results?.[i] ?? [null, null];
        if (!err && value === roomCode) owned.push(`user:${uid}`);
      });
    }

    const keys = [`room:${roomCode}:users`, `room:${roomCode}:nicknames`, ...owned];
    const deleted = await redis.del(...keys);
    return { deleted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Redis purge failed for room ${roomCode} (non-critical)`, { error: message });
    return { deleted: 0, error: `redis: ${message}` };
  }
};

/**
 * Drop every in-process Map/Set/gauge entry keyed by this room.
 *
 * Exported separately so every server instance can clear its own memory when
 * another instance performed the durable deletion (see the `room:purged`
 * broadcast at the end of purgeRoom) — Maps are per-process, so the deleting
 * instance clearing only its own would leave the other instances stale.
 */
export const clearInMemoryRoomState = (roomCode: string): number => {
  const timersCancelled = clearAllTimersForRoom(roomCode);
  clearScreenShareState(roomCode);
  clearRoomModeration(roomCode);
  clearSlowModeForRoom(roomCode);
  clearRoomReceipts(roomCode);
  clearRoomSocketCache(roomCode);
  invalidateRoomCache(roomCode);
  removeRoomMetrics(roomCode);
  return timersCancelled;
};

export const purgeRoom = async (
  roomCode: string,
  options: PurgeRoomOptions,
): Promise<PurgeRoomResult> => {
  const result: PurgeRoomResult = {
    roomCode,
    roomDeleted: false,
    messagesDeleted: 0,
    filesDeleted: 0,
    bannerAssignmentsDeleted: 0,
    userVisitsDeleted: 0,
    savedRoomRefsPruned: 0,
    socketsDisconnected: 0,
    redisKeysDeleted: 0,
    timersCancelled: 0,
    errors: [],
  };

  const {
    reason,
    trigger,
    event = 'room_vanished',
    actorId,
    systemMessage,
    purgeUserVisits = shouldPurgeUserVisitsByDefault(),
    recordStat = true,
  } = options;

  purgingRooms.add(roomCode);

  try {
    const io = getIoInstance();
    let socketUserIds: string[] = [];

    // ── 1-4. Notify, collect identities, then evict ──────────────────────────
    if (io) {
      try {
        if (systemMessage) {
          const { createMessage } = await import('./messageService.js');
          const message = await createMessage(roomCode, 'system', 'System', systemMessage, 'text');
          io.to(roomCode).emit('newMessage', message);
        }
      } catch (error) {
        // A missing farewell message must never block the teardown.
        result.errors.push(
          `systemMessage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      io.to(roomCode).emit(event, {
        reason,
        roomId: roomCode,
        vanishedBy: actorId,
        destroyedBy: actorId,
        terminatedBy: actorId,
        vanishedAt: new Date().toISOString(),
      });

      try {
        // Gather userIds BEFORE disconnecting — once the sockets are gone this
        // information is unrecoverable, and Redis alone can miss users whose
        // SADD failed during an outage.
        const sockets = await io.in(roomCode).fetchSockets();
        result.socketsDisconnected = sockets.length;
        socketUserIds = sockets
          .map((s: any) => s.data?.user?.userId as string | undefined)
          .filter((id): id is string => !!id);

        for (const socket of sockets) {
          socket.leave(roomCode);
        }
        io.in(roomCode).disconnectSockets(true);
      } catch (error) {
        result.errors.push(
          `disconnect: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // ── 5. Durable data ──────────────────────────────────────────────────────
    try {
      const files = await deleteRoomFiles(roomCode);
      result.filesDeleted = files.gcs;
    } catch (error) {
      result.errors.push(`files: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (mongoose.connection.readyState === 1) {
      const mongoOps: Array<Promise<void>> = [
        MessageModel.deleteMany({ roomCode })
          .then((r) => {
            result.messagesDeleted = r.deletedCount ?? 0;
          })
          .catch((e) => {
            result.errors.push(`messages: ${e instanceof Error ? e.message : String(e)}`);
          }),

        // The banner ASSET is a reusable library item that may be assigned to
        // other rooms — only this room's assignment is removed.
        RoomBannerAssignmentModel.deleteMany({ roomCode })
          .then((r) => {
            result.bannerAssignmentsDeleted = r.deletedCount ?? 0;
          })
          .catch((e) => {
            result.errors.push(`bannerAssignment: ${e instanceof Error ? e.message : String(e)}`);
          }),

        // Premium "saved rooms" pointing at a room that no longer exists would
        // otherwise accumulate on the user document forever.
        UserModel.updateMany(
          { 'savedRooms.roomCode': roomCode },
          { $pull: { savedRooms: { roomCode } } },
        )
          .then((r) => {
            result.savedRoomRefsPruned = r.modifiedCount ?? 0;
          })
          .catch((e) => {
            result.errors.push(`savedRooms: ${e instanceof Error ? e.message : String(e)}`);
          }),
      ];

      if (purgeUserVisits) {
        mongoOps.push(
          UserVisitModel.deleteMany({ roomCode })
            .then((r) => {
              result.userVisitsDeleted = r.deletedCount ?? 0;
            })
            .catch((e) => {
              result.errors.push(`userVisits: ${e instanceof Error ? e.message : String(e)}`);
            }),
        );
      }

      await Promise.all(mongoOps);

      // Room document last, so a crash mid-purge leaves the room discoverable
      // and therefore re-purgeable. Deleting it first would orphan everything
      // above with no owner record to find it by.
      //
      // Cache eviction happens right here, not in the step-7 in-memory sweep
      // below: the moment this document is gone, its code is free for
      // generateUniquePatternedRoomCode to hand to a brand-new room. If the
      // cache entry for this code survived until step 7 (which waits on
      // Redis + socket teardown), a fresh room created in that gap would have
      // its very first getRoomByCode read served this room's stale, deleted
      // data instead of its own — the recycled-code code reads as "joined an
      // existing room" from the client's point of view.
      invalidateRoomCache(roomCode);
      try {
        const roomResult = await RoomModel.deleteOne({ code: roomCode });
        result.roomDeleted = (roomResult.deletedCount ?? 0) > 0;
      } catch (error) {
        result.errors.push(`room: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      result.errors.push('mongo: not connected, document deletion skipped');
    }

    // ── 6. Redis ─────────────────────────────────────────────────────────────
    const redisResult = await purgeRedisForRoom(roomCode, socketUserIds);
    result.redisKeysDeleted = redisResult.deleted;
    if (redisResult.error) result.errors.push(redisResult.error);

    // ── 7. In-memory, on every instance ──────────────────────────────────────
    result.timersCancelled = clearInMemoryRoomState(roomCode);

    // Maps and gauges are per-process. On multi-instance Cloud Run the other
    // instances hold their own copies of this room's state and have no other
    // way to learn it is gone, so fan the clear out through the Redis adapter.
    if (io) {
      try {
        io.serverSideEmit('room:purged', roomCode);
      } catch (error) {
        // Not every adapter implements serverSideEmit. A failure here only
        // means other instances keep stale in-memory entries until their own
        // TTLs lapse — never a reason to fail the purge.
        logger.debug('Purge fan-out not delivered', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Only counted when this call is what actually removed the document —
    // otherwise a retry after a partial failure would inflate the stat.
    if (recordStat && result.roomDeleted) {
      import('./dailyStatsService.js')
        .then(({ recordRoomVanished }) => recordRoomVanished(VANISH_CAUSE_BY_TRIGGER[trigger]))
        .catch(() => {});
    }

    logger.info(`Purged room ${roomCode}`, {
      trigger,
      roomDeleted: result.roomDeleted,
      messagesDeleted: result.messagesDeleted,
      filesDeleted: result.filesDeleted,
      socketsDisconnected: result.socketsDisconnected,
      redisKeysDeleted: result.redisKeysDeleted,
      timersCancelled: result.timersCancelled,
      errorCount: result.errors.length,
    });

    if (result.errors.length > 0) {
      logger.warn(`Room purge for ${roomCode} completed with errors`, { errors: result.errors });
    }

    return result;
  } finally {
    // Held briefly past the teardown so late disconnect handlers — which are
    // async and can land after disconnectSockets resolves — still see the room
    // as purging and skip recreating timers for it.
    setTimeout(() => purgingRooms.delete(roomCode), 30_000).unref?.();
  }
};

/**
 * Registers the cross-instance handler for the `room:purged` fan-out above.
 * Must be called once after the Socket.IO server (and its Redis adapter) is
 * created; without it, only the instance that ran the purge clears its memory.
 */
export const registerPurgeFanoutHandler = (io: ReturnType<typeof getIoInstance>): void => {
  if (!io) return;
  io.on('room:purged', (roomCode: string) => {
    if (typeof roomCode !== 'string' || !roomCode) return;
    clearInMemoryRoomState(roomCode);
    logger.debug(`Cleared in-memory state for purged room ${roomCode} (fan-out)`);
  });
};

/** Exposed for the cleanup verifier, which reports the flag it ran under. */
export const purgeUserVisitsEnabled = (): boolean => shouldPurgeUserVisitsByDefault();
