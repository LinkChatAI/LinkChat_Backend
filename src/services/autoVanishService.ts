import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { deleteRoomFiles } from './gcsService.js';
import { logger } from '../utils/logger.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { emitAdminInsightUpdate } from '../socket/adminHandlers.js';
import { Server } from 'socket.io';

// Auto-vanish runs every 5 minutes for timely processing
const AUTO_VANISH_INTERVAL_MS = parseInt(process.env.AUTO_VANISH_INTERVAL_MS || '300000', 10); // 5 minutes default
const AUTO_VANISH_HOURS = 24; // Rooms auto-vanish 24 hours after being locked

/**
 * Calculate the auto-vanish timestamp (lockedAt + 24 hours)
 */
const calculateAutoVanishAt = (lockedAt: Date): Date => {
  return new Date(lockedAt.getTime() + AUTO_VANISH_HOURS * 60 * 60 * 1000);
};

/**
 * Permanently delete a room and all its associated data
 */
const permanentlyDeleteRoom = async (roomCode: string): Promise<void> => {
  try {
    // 1. Delete files from storage (GCS or local)
    try {
      await deleteRoomFiles(roomCode);
      logger.debug(`Deleted files for room ${roomCode}`);
    } catch (fileError: any) {
      logger.warn(`Failed to delete files for room ${roomCode} (non-critical)`, {
        error: fileError instanceof Error ? fileError.message : String(fileError),
      });
      // Continue with deletion even if file deletion fails
    }

    // 2. Delete all messages
    const messageDeleteResult = await MessageModel.deleteMany({ roomCode });
    logger.debug(`Deleted ${messageDeleteResult.deletedCount} messages from room ${roomCode}`);

    // 3. Delete the room
    const roomDeleteResult = await RoomModel.deleteOne({ code: roomCode });
    if (roomDeleteResult.deletedCount === 0) {
      logger.warn(`Room ${roomCode} was already deleted`);
    } else {
      logger.info(`Deleted room ${roomCode}`);
    }

    // 4. Clean up Redis if available
    const redis = getRedisClient();
    if (redis && isRedisAvailable()) {
      try {
        await redis.del(`room:${roomCode}:users`);
        // Clean up user entries that reference this room
        const keys = await redis.keys('user:*');
        for (const key of keys) {
          const userRoomCode = await redis.hget(key, 'roomCode');
          if (userRoomCode === roomCode) {
            await redis.del(key);
          }
        }
        logger.debug(`Cleaned up Redis data for room ${roomCode}`);
      } catch (redisError: any) {
        logger.warn('Redis cleanup failed (non-critical)', {
          error: redisError instanceof Error ? redisError.message : String(redisError),
        });
      }
    }
  } catch (error: any) {
    logger.error(`Error permanently deleting room ${roomCode}`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
};

/**
 * Process auto-vanish for locked rooms that have exceeded 24 hours
 * Returns the number of rooms vanished
 */
export const processAutoVanish = async (): Promise<number> => {
  // Check if database is connected
  if (mongoose.connection.readyState !== 1) {
    logger.debug('Database not connected, skipping auto-vanish');
    return 0;
  }

  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - AUTO_VANISH_HOURS * 60 * 60 * 1000);

    // Find locked rooms where lockedAt is more than 24 hours ago
    // Only process rooms that are not already ended
    const roomsToVanish = await RoomModel.find({
      isLocked: true,
      lockedAt: {
        $exists: true,
        $lt: twentyFourHoursAgo,
      },
      isEnded: { $ne: true }, // Don't process already ended rooms
      expiresAt: { $gt: now }, // Only process rooms that haven't expired naturally
    })
      .select('code lockedAt')
      .limit(100) // Process in smaller batches for reliability
      .lean()
      .exec();

    if (roomsToVanish.length === 0) {
      logger.debug('No locked rooms ready for auto-vanish');
      return 0;
    }

    logger.info(`Processing auto-vanish for ${roomsToVanish.length} locked rooms`, {
      roomCodes: roomsToVanish.map((r: any) => r.code),
    });

    const roomCodes = roomsToVanish.map((room: any) => room.code);
    let vanishedCount = 0;
    const errors: string[] = [];

    // Process rooms sequentially to avoid overwhelming the system
    // But use Promise.all for parallel file deletion within each room
    for (const roomCode of roomCodes) {
      try {
        await permanentlyDeleteRoom(roomCode);
        vanishedCount++;

        // Emit admin insight update for each vanished room
        const io = getIoInstance();
        if (io) {
          emitAdminInsightUpdate(io, 'room_auto_vanished', { roomCode }).catch((err) => {
            logger.warn('Failed to emit admin insight update for auto-vanish', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`${roomCode}: ${errorMsg}`);
        logger.error(`Failed to auto-vanish room ${roomCode}`, {
          error: errorMsg,
          stack: error instanceof Error ? error.stack : undefined,
        });
        // Continue processing other rooms even if one fails
      }
    }

    if (errors.length > 0) {
      logger.warn(`Auto-vanish completed with ${errors.length} errors`, { errors });
    }

    logger.info(`Auto-vanish completed: ${vanishedCount}/${roomCodes.length} rooms vanished successfully`);

    return vanishedCount;
  } catch (error: any) {
    logger.error('Error processing auto-vanish', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return 0;
  }
};

/**
 * Fail-safe recovery: Check for any locked rooms that should have been vanished
 * but weren't (e.g., due to server restart during processing)
 * This runs on startup to ensure no rooms are stuck in locked state
 */
export const recoverStuckRooms = async (): Promise<number> => {
  // Check if database is connected
  if (mongoose.connection.readyState !== 1) {
    logger.debug('Database not connected, skipping recovery');
    return 0;
  }

  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - AUTO_VANISH_HOURS * 60 * 60 * 1000);

    // Find any locked rooms that should have been vanished
    const stuckRooms = await RoomModel.find({
      isLocked: true,
      lockedAt: {
        $exists: true,
        $lt: twentyFourHoursAgo,
      },
      isEnded: { $ne: true },
    })
      .select('code lockedAt')
      .limit(500) // Process more on recovery
      .lean()
      .exec();

    if (stuckRooms.length === 0) {
      logger.info('No stuck rooms found during recovery');
      return 0;
    }

    logger.warn(`Recovery: Found ${stuckRooms.length} stuck locked rooms, processing auto-vanish`, {
      roomCodes: stuckRooms.map((r: any) => r.code),
    });

    const roomCodes = stuckRooms.map((room: any) => room.code);
    let vanishedCount = 0;

    // Process in batches to avoid overwhelming the system
    const batchSize = 50;
    for (let i = 0; i < roomCodes.length; i += batchSize) {
      const batch = roomCodes.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async (roomCode) => {
          try {
            await permanentlyDeleteRoom(roomCode);
            vanishedCount++;

            // Emit admin insight update
            const io = getIoInstance();
            if (io) {
              emitAdminInsightUpdate(io, 'room_auto_vanished', { roomCode }).catch((err) => {
                logger.warn('Failed to emit admin insight update during recovery', {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          } catch (error: any) {
            logger.error(`Recovery: Failed to vanish stuck room ${roomCode}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
      );

      // Small delay between batches to avoid overwhelming the system
      if (i + batchSize < roomCodes.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    logger.info(`Recovery completed: ${vanishedCount}/${roomCodes.length} stuck rooms vanished`);

    return vanishedCount;
  } catch (error: any) {
    logger.error('Error during recovery of stuck rooms', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return 0;
  }
};

/**
 * Start the auto-vanish background worker
 * Runs every 5 minutes and processes locked rooms that have exceeded 24 hours
 */
export const startAutoVanishWorker = (): NodeJS.Timeout => {
  logger.info('Starting auto-vanish worker', {
    intervalMs: AUTO_VANISH_INTERVAL_MS,
    autoVanishHours: AUTO_VANISH_HOURS,
  });

  // Run recovery immediately on startup (fail-safe)
  recoverStuckRooms().catch((error) => {
    logger.error('Recovery failed on startup', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Run auto-vanish check immediately, then on interval
  processAutoVanish().catch((error) => {
    logger.error('Initial auto-vanish check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Set up interval for regular checks
  return setInterval(() => {
    processAutoVanish().catch((error) => {
      logger.error('Auto-vanish check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, AUTO_VANISH_INTERVAL_MS);
};

/**
 * Get rooms that will auto-vanish soon (for admin dashboard)
 * Returns rooms that will vanish in the next hour
 */
export const getRoomsVanishingSoon = async (hours: number = 1): Promise<number> => {
  if (mongoose.connection.readyState !== 1) {
    return 0;
  }

  try {
    const now = new Date();
    const targetTime = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const minLockedAt = new Date(targetTime.getTime() - AUTO_VANISH_HOURS * 60 * 60 * 1000);

    const count = await RoomModel.countDocuments({
      isLocked: true,
      lockedAt: {
        $exists: true,
        $gte: minLockedAt,
        $lt: new Date(now.getTime() - (AUTO_VANISH_HOURS - hours) * 60 * 60 * 1000),
      },
      isEnded: { $ne: true },
      expiresAt: { $gt: now },
    });

    return count;
  } catch (error: any) {
    logger.error('Error getting rooms vanishing soon', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
};

