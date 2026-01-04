import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { deleteRoomFiles } from './gcsService.js';
import { logger } from '../utils/logger.js';
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
        // Clean up Redis if available
        const redis = getRedisClient();
        if (redis && isRedisAvailable()) {
            try {
                for (const code of roomCodes) {
                    await redis.del(`room:${code}:users`);
                    const keys = await redis.keys(`user:*`);
                    for (const key of keys) {
                        const userData = await redis.hget(key, 'roomCode');
                        if (userData === code) {
                            await redis.del(key);
                        }
                    }
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
export const startCleanupJob = () => {
    logger.info('Starting cleanup job', { intervalMs: CLEANUP_INTERVAL_MS });
    cleanupExpiredRooms();
    return setInterval(() => {
        cleanupExpiredRooms();
    }, CLEANUP_INTERVAL_MS);
};
//# sourceMappingURL=cleanupService.js.map