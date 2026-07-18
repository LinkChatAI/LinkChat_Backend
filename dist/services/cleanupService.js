import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { deleteRoomFiles } from './gcsService.js';
import { logger } from '../utils/logger.js';
import { clearRoomModeration } from './roomModerationService.js';
import { clearSlowModeForRoom } from './slowModeService.js';
import { clearRoomReceipts } from './readReceiptService.js';
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10); // 1 hour default
export const cleanupExpiredRooms = async () => {
    // Check if database is connected
    if (mongoose.connection.readyState !== 1) {
        logger.debug('Database not connected, skipping cleanup');
        return;
    }
    try {
        const now = new Date();
        // Use batch processing for large deletions
        const expiredRooms = await RoomModel.find({ expiresAt: { $lt: now } })
            .select('code')
            .limit(1000) // Process in batches
            .lean()
            .exec();
        if (expiredRooms.length === 0) {
            logger.debug('No expired rooms to clean up');
            return;
        }
        const roomCodes = expiredRooms.map((room) => room.code);
        // Delete files for each expired room
        await Promise.all(roomCodes.map(code => deleteRoomFiles(code).catch(err => {
            logger.warn(`Failed to delete files for room ${code}`, { error: err });
        })));
        // Delete rooms and messages in parallel
        const [roomResult, messageResult] = await Promise.all([
            RoomModel.deleteMany({ expiresAt: { $lt: now } }),
            MessageModel.deleteMany({ roomCode: { $in: roomCodes } }),
        ]);
        // Clear in-memory per-room state for expired rooms
        for (const code of roomCodes) {
            clearRoomModeration(code);
            clearSlowModeForRoom(code);
            clearRoomReceipts(code);
        }
        // Clean up Redis if available
        const redis = getRedisClient();
        if (redis && isRedisAvailable()) {
            try {
                for (const code of roomCodes) {
                    // Use the room's member set as a reverse index instead of scanning
                    // the whole keyspace with KEYS (O(all users) and blocks Redis).
                    const userIds = await redis.smembers(`room:${code}:users`);
                    for (const uid of userIds) {
                        const userRoomCode = await redis.hget(`user:${uid}`, 'roomCode');
                        if (userRoomCode === code) {
                            await redis.del(`user:${uid}`);
                        }
                    }
                    await redis.del(`room:${code}:users`);
                }
            }
            catch (error) {
                // Ignore Redis errors during cleanup
                logger.debug('Redis cleanup skipped', { error: error instanceof Error ? error.message : String(error) });
            }
        }
        logger.info('Cleaned up expired rooms', {
            roomCount: roomResult.deletedCount,
            messageCount: messageResult.deletedCount,
        });
    }
    catch (error) {
        logger.error('Error cleaning up expired rooms', { error: error instanceof Error ? error.message : String(error) });
    }
};
// DEPRECATED: Use autoVanishService.processAutoVanish() instead
// This function is kept for backward compatibility but auto-vanish is now handled
// by the dedicated auto-vanish worker service
export const cleanupLockedRooms = async () => {
    // Auto-vanish is now handled by autoVanishService
    // This function is kept for backward compatibility but does nothing
    logger.debug('cleanupLockedRooms is deprecated, auto-vanish handled by autoVanishService');
};
export const startCleanupJob = () => {
    logger.info('Starting cleanup job', { intervalMs: CLEANUP_INTERVAL_MS });
    // Run cleanup immediately
    cleanupExpiredRooms();
    // Note: cleanupLockedRooms is deprecated, auto-vanish handled by autoVanishService
    return setInterval(() => {
        cleanupExpiredRooms();
        // Note: cleanupLockedRooms is deprecated, auto-vanish handled by autoVanishService
    }, CLEANUP_INTERVAL_MS);
};
//# sourceMappingURL=cleanupService.js.map