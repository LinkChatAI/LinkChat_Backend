import { Server } from 'socket.io';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { AdminActionModel } from '../models/AdminAction.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { deleteRoomFiles } from './gcsService.js';
import { logger } from '../utils/logger.js';
import { getIoInstance } from '../socket/ioInstance.js';
import { emitAdminInsightUpdate } from '../socket/adminHandlers.js';
import { createMessage } from './messageService.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Admin-controlled room vanish
 * Immediately destroys a room (active or locked) with proper cleanup and user notification
 */
export const adminVanishRoom = async (
  roomCode: string,
  adminId: string,
  previousStatus: 'active' | 'locked'
): Promise<void> => {
  const io = getIoInstance();
  if (!io) {
    throw new Error('Socket.IO instance not available');
  }

  // 1. Verify room exists and get current state
  const room = await RoomModel.findOne({ code: roomCode });
  if (!room) {
    throw new Error(`Room ${roomCode} not found`);
  }

  // 2. Broadcast system message before deletion
  try {
    const systemMessage = await createMessage(
      roomCode,
      'system',
      'System',
      'This room has been vanished by an administrator.',
      'text'
    );
    io.to(roomCode).emit('newMessage', systemMessage);
    logger.info(`Broadcast system message for admin-vanished room ${roomCode}`);
    
    // Small delay to ensure message is received
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (msgError: any) {
    logger.warn('Failed to broadcast system message (non-critical)', {
      error: msgError instanceof Error ? msgError.message : String(msgError),
    });
    // Continue with room deletion even if system message fails
  }

  // 3. Emit room_vanished event to all clients
  io.to(roomCode).emit('room_vanished', {
    reason: 'This room has been vanished by an administrator.',
    roomId: roomCode,
    vanishedBy: 'admin',
  });

  // 4. Force disconnect all sockets in that room
  const socketsInRoom = await io.in(roomCode).fetchSockets();
  for (const socketInRoom of socketsInRoom) {
    socketInRoom.leave(roomCode);
  }
  io.in(roomCode).disconnectSockets(true);

  // 5. Delete files from storage (GCS or local)
  try {
    await deleteRoomFiles(roomCode);
    logger.info(`Deleted files for admin-vanished room ${roomCode}`);
  } catch (fileError: any) {
    logger.warn(`Failed to delete files for room ${roomCode} (non-critical)`, {
      error: fileError instanceof Error ? fileError.message : String(fileError),
    });
    // Continue with deletion even if file deletion fails
  }

  // 6. Delete all messages
  const messageDeleteResult = await MessageModel.deleteMany({ roomCode });
  logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from admin-vanished room ${roomCode}`);

  // 7. Delete the room
  const roomDeleteResult = await RoomModel.deleteOne({ code: roomCode });
  if (roomDeleteResult.deletedCount === 0) {
    logger.warn(`Room ${roomCode} was already deleted`);
  } else {
    logger.info(`Admin-vanished room ${roomCode}`);
  }

  // 8. Clean up Redis if available
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
      logger.debug(`Cleaned up Redis data for admin-vanished room ${roomCode}`);
    } catch (redisError: any) {
      logger.warn('Redis cleanup failed (non-critical)', {
        error: redisError instanceof Error ? redisError.message : String(redisError),
      });
    }
  }

  // 9. Log admin action to audit log
  try {
    await AdminActionModel.create({
      adminId,
      action: 'room_vanished',
      endpoint: `/admin/rooms/${roomCode}/vanish`,
      method: 'POST',
      ipAddress: 'system', // Will be set by middleware
      requestId: uuidv4(),
      success: true,
      metadata: {
        roomCode,
        previousStatus,
        roomName: room.name || roomCode,
        participantsCount: room.participants?.length || 0,
        messagesDeleted: messageDeleteResult.deletedCount,
      },
    });
  } catch (auditError: any) {
    logger.error('Failed to log admin action', {
      error: auditError instanceof Error ? auditError.message : String(auditError),
    });
    // Don't throw - audit logging failure shouldn't fail the operation
  }

  // 10. Emit admin insight update
  try {
    await emitAdminInsightUpdate(io, 'room_admin_vanished', {
      roomCode,
      previousStatus,
      adminId,
    });
  } catch (insightError: any) {
    logger.warn('Failed to emit admin insight update', {
      error: insightError instanceof Error ? insightError.message : String(insightError),
    });
  }
};

