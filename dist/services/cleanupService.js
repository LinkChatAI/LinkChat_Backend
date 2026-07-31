import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { logger } from '../utils/logger.js';
import { purgeRoom } from './roomPurgeService.js';
import { recordJobRun } from './jobHealthService.js';
/**
 * Expired-room sweep.
 *
 * This is now the ONLY thing that deletes expired rooms — the TTL index on
 * Room.expiresAt was removed (see models/Room.ts) because mongod deleting the
 * document directly ran no application code and orphaned every other resource
 * the room owned. Interval defaults to 5 minutes rather than the old hour:
 * with no TTL backstop, this interval is the actual upper bound on how long an
 * expired room's data survives.
 */
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '300000', 10);
/** Bounds the work of a single tick; the next tick picks up the remainder. */
const CLEANUP_BATCH_SIZE = parseInt(process.env.CLEANUP_BATCH_SIZE || '200', 10);
/**
 * Purges rooms sequentially rather than in parallel. Each purge does GCS list
 * + delete, several Mongo deletes, a Redis pipeline, and a socket fan-out;
 * running 200 of those concurrently is exactly the kind of burst that stalls
 * the event loop and drops live connections on a shared instance.
 */
export const cleanupExpiredRooms = async () => {
    if (mongoose.connection.readyState !== 1) {
        logger.debug('Database not connected, skipping cleanup');
        return 0;
    }
    try {
        const now = new Date();
        const expiredRooms = await RoomModel.find({ expiresAt: { $lt: now } })
            .select('code')
            .limit(CLEANUP_BATCH_SIZE)
            .lean()
            .exec();
        if (expiredRooms.length === 0) {
            logger.debug('No expired rooms to clean up');
            return 0;
        }
        logger.info(`Cleaning up ${expiredRooms.length} expired rooms`);
        let purged = 0;
        for (const room of expiredRooms) {
            try {
                await purgeRoom(room.code, {
                    reason: 'This room has expired.',
                    trigger: 'expired',
                    event: 'room_vanished',
                });
                purged++;
            }
            catch (error) {
                // One bad room must not stop the sweep — it will be retried next tick.
                logger.error(`Failed to purge expired room ${room.code}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        logger.info('Cleaned up expired rooms', { purged, found: expiredRooms.length });
        if (expiredRooms.length === CLEANUP_BATCH_SIZE) {
            logger.warn('Expired-room cleanup hit its batch limit; remainder deferred to next tick', {
                batchSize: CLEANUP_BATCH_SIZE,
            });
        }
        return purged;
    }
    catch (error) {
        logger.error('Error cleaning up expired rooms', {
            error: error instanceof Error ? error.message : String(error),
        });
        return 0;
    }
};
/**
 * Rooms explicitly ended by their owner (isEnded) were previously never
 * deleted by anything: processAutoVanish excludes them and the expiry sweep
 * only matches expiresAt, so they sat holding files and Redis keys until their
 * expiry time arrived. They are purged here after a short grace period, which
 * exists so a host who ends a room by mistake still has a window in which the
 * data is recoverable by support.
 */
const ENDED_ROOM_GRACE_MS = parseInt(process.env.ENDED_ROOM_GRACE_MS || '3600000', 10); // 1h
export const cleanupEndedRooms = async () => {
    if (mongoose.connection.readyState !== 1)
        return 0;
    try {
        const cutoff = new Date(Date.now() - ENDED_ROOM_GRACE_MS);
        const endedRooms = await RoomModel.find({ isEnded: true, endedAt: { $lt: cutoff } })
            .select('code')
            .limit(CLEANUP_BATCH_SIZE)
            .lean()
            .exec();
        if (endedRooms.length === 0)
            return 0;
        let purged = 0;
        for (const room of endedRooms) {
            try {
                await purgeRoom(room.code, {
                    reason: 'This room was ended by its host.',
                    trigger: 'owner',
                    event: 'room_vanished',
                    // roomService.endRoom already counted this vanish when the host ended
                    // the room; counting again here would double it.
                    recordStat: false,
                });
                purged++;
            }
            catch (error) {
                logger.error(`Failed to purge ended room ${room.code}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        logger.info('Cleaned up ended rooms', { purged, found: endedRooms.length });
        return purged;
    }
    catch (error) {
        logger.error('Error cleaning up ended rooms', {
            error: error instanceof Error ? error.message : String(error),
        });
        return 0;
    }
};
export const runCleanupTick = async () => {
    await cleanupExpiredRooms();
    await cleanupEndedRooms();
};
export const startCleanupJob = () => {
    logger.info('Starting cleanup job', { intervalMs: CLEANUP_INTERVAL_MS });
    recordJobRun('cleanup', runCleanupTick).catch((error) => {
        logger.error('Initial cleanup tick failed', {
            error: error instanceof Error ? error.message : String(error),
        });
    });
    return setInterval(() => {
        recordJobRun('cleanup', runCleanupTick).catch((error) => {
            logger.error('Cleanup tick failed', {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }, CLEANUP_INTERVAL_MS);
};
//# sourceMappingURL=cleanupService.js.map