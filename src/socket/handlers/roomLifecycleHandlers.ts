import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { getRedisClient, isRedisAvailable } from '../../config/redis.js';
import { getRoomByCode, verifyRoomToken, lockRoom } from '../../services/roomService.js';
import { createMessage } from '../../services/messageService.js';
import { logger } from '../../utils/logger.js';
import { MessageModel } from '../../models/Message.js';
import { RoomModel } from '../../models/Room.js';
import { emitAdminInsightUpdate } from '../adminHandlers.js';
import { HandlerContext } from './types.js';
import { clearScreenShareState } from '../screenShareState.js';
import { handleScreenShareParticipantLeft, stopScreenSharePresentation } from '../screenShareService.js';

const getRedis = () => getRedisClient();

// Map to track pending deletion timers for rooms with disconnected admins
const pendingDeletionTimers = new Map<string, NodeJS.Timeout>();

export const hasPendingDeletion = (roomCode: string): boolean =>
  pendingDeletionTimers.has(roomCode);

export const clearPendingDeletionTimer = (roomCode: string): void => {
  const timer = pendingDeletionTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    pendingDeletionTimers.delete(roomCode);
    logger.info(`Cleared pending deletion timer for room ${roomCode}`);
  }
};

const destroyRoomAfterGracePeriod = async (io: Server, roomCode: string, adminUserId: string): Promise<void> => {
  try {
    logger.info(`Grace period expired for room ${roomCode}, destroying room`);

    pendingDeletionTimers.delete(roomCode);

    const room = await getRoomByCode(roomCode);
    if (!room) {
      logger.info(`Room ${roomCode} already deleted, skipping destruction`);
      return;
    }

    if (mongoose.connection.readyState !== 1) {
      logger.error('Database not connected during grace period expiration', { readyState: mongoose.connection.readyState });
      return;
    }

    try {
      const systemMessage = await createMessage(
        roomCode, 'system', 'System',
        'Admin disconnected. Room closed after grace period.', 'text'
      );
      io.to(roomCode).emit('newMessage', systemMessage);
    } catch (msgError: any) {
      logger.warn('Failed to broadcast system message (non-critical)', {
        error: msgError instanceof Error ? msgError.message : String(msgError),
      });
    }

    try {
      const { deleteRoomFiles } = await import('../../services/gcsService.js');
      await deleteRoomFiles(roomCode);
    } catch (fileError: any) {
      logger.warn('Failed to delete room files (non-critical)', {
        error: fileError instanceof Error ? fileError.message : String(fileError),
      });
    }

    const messageDeleteResult = await MessageModel.deleteMany({ roomCode });
    logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${roomCode} after grace period`);

    const roomDeleteResult = await RoomModel.deleteOne({ code: roomCode });
    logger.info(`Deleted room ${roomCode} after grace period`, { deleted: roomDeleteResult.deletedCount });

    clearScreenShareState(roomCode);

    io.to(roomCode).emit('room_vanished', {
      reason: 'Admin disconnected. Room closed after grace period.',
      roomId: roomCode,
      vanishedBy: adminUserId,
    });

    const socketsInRoom = await io.in(roomCode).fetchSockets();
    for (const socketInRoom of socketsInRoom) {
      socketInRoom.leave(roomCode);
    }
    io.in(roomCode).disconnectSockets(true);

    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      try {
        await redis.del(`room:${roomCode}:users`);
        const socketsForRedis = await io.in(roomCode).fetchSockets();
        for (const socketInRoom of socketsForRedis) {
          const socketUser = (socketInRoom as any).data?.user;
          if (socketUser?.userId) {
            await redis.del(`user:${socketUser.userId}`);
          }
        }
        logger.info(`Cleaned up Redis data for room ${roomCode} after grace period`);
      } catch (redisError: any) {
        logger.warn('Redis cleanup failed (non-critical)', {
          error: redisError instanceof Error ? redisError.message : String(redisError),
        });
      }
    }

    emitAdminInsightUpdate(io, 'room_vanished', { roomCode }).catch(err => {
      logger.warn('Failed to emit admin insight update for room vanished', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info(`Room ${roomCode} destroyed after grace period expiration`);
  } catch (error: any) {
    logger.error('Error destroying room after grace period', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      roomCode,
    });
  }
};

export const registerRoomLifecycleHandlers = (ctx: HandlerContext): void => {
  const { io, socket, user } = ctx;

  const handleUserLeaveRoom = async (
    roomCodeToLeave: string,
    userId: string,
    shouldEmitRoomLeft: boolean = true,
  ): Promise<void> => {
    if (!roomCodeToLeave || !roomCodeToLeave.trim()) return;

    try {
      handleScreenShareParticipantLeft(io, roomCodeToLeave, userId);

      const redis = getRedis();

      if (redis && isRedisAvailable()) {
        try {
          await redis.srem(`room:${roomCodeToLeave}:users`, userId);
          await redis.del(`user:${userId}`);
        } catch (error: any) {
          logger.warn('Redis cleanup error during leave room', {
            error: error instanceof Error ? error.message : String(error),
            roomCode: roomCodeToLeave, userId,
          });
        }
      }

      socket.leave(roomCodeToLeave);
      socket.to(roomCodeToLeave).emit('user_left', { userId, roomId: roomCodeToLeave });

      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${roomCodeToLeave}:users`);
        } catch (error: any) {
          userCount = io.sockets.adapter.rooms.get(roomCodeToLeave)?.size || 0;
        }
      } else {
        userCount = io.sockets.adapter.rooms.get(roomCodeToLeave)?.size || 0;
      }
      io.to(roomCodeToLeave).emit('userCount', { count: userCount });

      if (shouldEmitRoomLeft) {
        socket.emit('roomLeft', { roomId: roomCodeToLeave });
      }

      logger.info(`User ${userId} left room ${roomCodeToLeave}`);

      try {
        const { UserVisitModel } = await import('../../models/UserVisit.js');
        const { MessageModel: MsgModel } = await import('../../models/Message.js');

        const visit = await UserVisitModel.findOne({
          userId,
          roomCode: roomCodeToLeave,
          leftAt: { $exists: false },
        }).sort({ joinedAt: -1 });

        if (visit) {
          const leftAt = new Date();
          const sessionDuration = leftAt.getTime() - visit.joinedAt.getTime();
          const messagesSent = await MsgModel.countDocuments({
            userId,
            roomCode: roomCodeToLeave,
            createdAt: { $gte: visit.joinedAt, $lte: leftAt },
          });
          await UserVisitModel.updateOne(
            { _id: visit._id },
            { $set: { leftAt, sessionDuration, messagesSent } }
          );
        }
      } catch (visitError: any) {
        logger.warn('Failed to update user visit on leave', {
          error: visitError instanceof Error ? visitError.message : String(visitError),
          userId, roomCode: roomCodeToLeave,
        });
      }

      if (shouldEmitRoomLeft) {
        emitAdminInsightUpdate(io, 'user_left', { roomCode: roomCodeToLeave, userId }).catch(err => {
          logger.warn('Failed to emit admin insight update for user leave', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (error: any) {
      logger.error('Error in handleUserLeaveRoom', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: roomCodeToLeave, userId,
      });
      throw error;
    }
  };

  socket.on('leave_room', async (data: { roomId: string }) => {
    if (!data || typeof data.roomId !== 'string' || !data.roomId.trim()) {
      socket.emit('error', { message: 'Invalid room ID' });
      return;
    }

    const roomId = data.roomId.trim();

    if (!user.roomCode || user.roomCode !== roomId) {
      socket.emit('error', { message: 'Not in the specified room' });
      return;
    }

    try {
      const authUserId = socket.handshake.auth?.userId || user.userId;
      const room = await getRoomByCode(roomId);

      if (room && room.ownerId && room.ownerId === authUserId && !room.isLocked && !room.isEnded) {
        logger.info(`Admin ${authUserId} leaving room ${roomId} - locking room for 24h`);
        await lockRoom(roomId);

        io.to(roomId).emit('room_locked', {
          roomId,
          lockedAt: new Date().toISOString(),
        });

        stopScreenSharePresentation(io, roomId, authUserId, 'Room was locked by the host');

        emitAdminInsightUpdate(io, 'room_locked', { roomCode: roomId }).catch(err => {
          logger.warn('Failed to emit admin insight update for room locked', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      await handleUserLeaveRoom(roomId, user.userId, true);
      user.roomCode = '';
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  socket.on('leaveRoom', async () => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    try {
      await handleUserLeaveRoom(user.roomCode, user.userId, true);
      user.roomCode = '';
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  socket.on('disconnect', async () => {
    if (user.roomCode) {
      logger.debug(`User ${user.userId} disconnecting from room ${user.roomCode}`);
      try {
        const authUserId = socket.handshake.auth?.userId || user.userId;
        const room = await getRoomByCode(user.roomCode);

        if (room && room.ownerId && room.ownerId === authUserId && !room.isLocked && !room.isEnded) {
          logger.info(`Admin ${authUserId} disconnected from room ${user.roomCode} - starting 2-minute grace period`);
          clearPendingDeletionTimer(user.roomCode);

          const gracePeriodMs = 120000;
          const timer = setTimeout(() => {
            destroyRoomAfterGracePeriod(io, user.roomCode, authUserId).catch(err => {
              logger.error('Error in destroyRoomAfterGracePeriod', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }, gracePeriodMs);

          pendingDeletionTimers.set(user.roomCode, timer);

          io.to(user.roomCode).emit('adminOffline', {
            roomId: user.roomCode,
            message: 'Admin disconnected. Room will close in 2 minutes if admin does not reconnect.',
            gracePeriodSeconds: 120,
          });

          logger.info(`Grace period timer started for room ${user.roomCode}, will expire in ${gracePeriodMs}ms`);
        } else {
          await handleUserLeaveRoom(user.roomCode, user.userId, false);
        }

        user.roomCode = '';
      } catch (error: any) {
        logger.error('Error handling disconnect cleanup', {
          error: error instanceof Error ? error.message : String(error),
          roomCode: user.roomCode, userId: user.userId,
        });
      }
    }
  });

  socket.on('endRoom', async (data: { userId: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    try {
      const { endRoom } = await import('../../services/roomService.js');
      await endRoom(user.roomCode, data.userId);
      io.to(user.roomCode).emit('roomEnded', { endedBy: data.userId });
      logger.info(`Room ${user.roomCode} ended by ${data.userId}`);
    } catch (error: any) {
      logger.error('Error ending room', { error: error instanceof Error ? error.message : String(error) });
      socket.emit('error', { message: 'Failed to end room' });
    }
  });

  socket.on('userLeaveRoom', async (data: { userId: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    try {
      const { removeParticipant } = await import('../../services/roomService.js');
      await removeParticipant(user.roomCode, data.userId);
      socket.to(user.roomCode).emit('userLeftRoom', { userId: data.userId });
      socket.leave(user.roomCode);
      logger.info(`User ${data.userId} left room ${user.roomCode}`);

      emitAdminInsightUpdate(io, 'user_left', { roomCode: user.roomCode, userId: data.userId }).catch(err => {
        logger.warn('Failed to emit admin insight update for user leave', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (error: any) {
      logger.error('Error user leaving room', { error: error instanceof Error ? error.message : String(error) });
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  socket.on('admin_end_room', async (data: { roomId?: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    const targetRoomId = data.roomId?.trim() || user.roomCode;

    if (user.roomCode !== targetRoomId) {
      socket.emit('error', { message: 'Not in the specified room' });
      return;
    }

    try {
      const room = await getRoomByCode(targetRoomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const authUserId = socket.handshake.auth?.userId;
      if (!room.ownerId || !authUserId || room.ownerId !== authUserId) {
        logger.warn(`Unauthorized room termination attempt: room.ownerId=${room.ownerId}, auth.userId=${authUserId}, requester=${user.userId} in room ${targetRoomId}`);
        socket.emit('error_unauthorized', { message: 'Unauthorized: Only the room creator can end the room' });
        return;
      }

      clearPendingDeletionTimer(targetRoomId);

      logger.info(`Admin ${user.userId} (ownerId: ${room.ownerId}) ending room ${targetRoomId}`);

      if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected', { readyState: mongoose.connection.readyState });
        throw new Error('Database connection not available');
      }

      try {
        const systemMessage = await createMessage(
          targetRoomId, 'system', 'System',
          'The owner has vanished the room.', 'text'
        );
        io.to(targetRoomId).emit('newMessage', systemMessage);
      } catch (msgError: any) {
        logger.warn('Failed to broadcast system message (non-critical)', {
          error: msgError instanceof Error ? msgError.message : String(msgError),
        });
      }

      try {
        const { deleteRoomFiles } = await import('../../services/gcsService.js');
        await deleteRoomFiles(targetRoomId);
      } catch (fileError: any) {
        logger.warn('Failed to delete room files (non-critical)', {
          error: fileError instanceof Error ? fileError.message : String(fileError),
        });
      }

      const messageDeleteResult = await MessageModel.deleteMany({ roomCode: targetRoomId });
      logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${targetRoomId}`);

      const roomDeleteResult = await RoomModel.deleteOne({ code: targetRoomId });
      logger.info(`Deleted room ${targetRoomId}`, { deleted: roomDeleteResult.deletedCount });

      clearScreenShareState(targetRoomId);

      io.to(targetRoomId).emit('room_vanished', {
        reason: 'The owner has vanished the room.',
        roomId: targetRoomId,
        vanishedBy: user.userId,
      });

      const socketsInRoom = await io.in(targetRoomId).fetchSockets();
      for (const socketInRoom of socketsInRoom) {
        socketInRoom.leave(targetRoomId);
      }
      io.in(targetRoomId).disconnectSockets(true);

      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.del(`room:${targetRoomId}:users`);
          const socketsForRedis = await io.in(targetRoomId).fetchSockets();
          for (const socketInRoom of socketsForRedis) {
            const socketUser = (socketInRoom as any).data?.user;
            if (socketUser?.userId) await redis.del(`user:${socketUser.userId}`);
          }
          logger.info(`Cleaned up Redis data for room ${targetRoomId}`);
        } catch (redisError: any) {
          logger.warn('Redis cleanup failed (non-critical)', {
            error: redisError instanceof Error ? redisError.message : String(redisError),
          });
        }
      }

      logger.info(`Room ${targetRoomId} terminated successfully by admin ${user.userId}. Disconnected ${socketsInRoom.length} sockets.`);

      emitAdminInsightUpdate(io, 'room_vanished', { roomCode: targetRoomId }).catch(err => {
        logger.warn('Failed to emit admin insight update for room vanished', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      user.roomCode = '';
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error ending room', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: targetRoomId, userId: user.userId,
      });

      let userFriendlyMessage = 'Failed to end room';
      if (errorMessage.includes('not connected') || errorMessage.includes('database')) {
        userFriendlyMessage = 'Database connection error. Please try again.';
      } else if (errorMessage.includes('permission') || errorMessage.includes('unauthorized')) {
        userFriendlyMessage = 'You are not authorized to end this meeting.';
      } else if (errorMessage) {
        userFriendlyMessage = `Failed to end room: ${errorMessage}`;
      }

      socket.emit('error', { message: userFriendlyMessage });
    }
  });

  socket.on('destroy_room', async (data: { roomToken?: string; adminSecret?: string; roomId?: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    const targetRoomId = data.roomId?.trim() || user.roomCode;

    if (user.roomCode !== targetRoomId) {
      socket.emit('error', { message: 'Not in the specified room' });
      return;
    }

    try {
      const room = await getRoomByCode(targetRoomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const authUserId = socket.handshake.auth?.userId;
      if (!room.ownerId || !authUserId || room.ownerId !== authUserId) {
        logger.warn(`Unauthorized room destruction attempt: room.ownerId=${room.ownerId}, auth.userId=${authUserId}, requester=${user.userId} in room ${targetRoomId}`);
        socket.emit('error_unauthorized', { message: 'Unauthorized: Only the room creator can end the room' });
        return;
      }

      clearPendingDeletionTimer(targetRoomId);

      logger.info(`Admin ${user.userId} destroying room ${targetRoomId}`);

      if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected', { readyState: mongoose.connection.readyState });
        throw new Error('Database connection not available');
      }

      const messageDeleteResult = await MessageModel.deleteMany({ roomCode: targetRoomId });
      logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${targetRoomId}`);

      const roomDeleteResult = await RoomModel.deleteOne({ code: targetRoomId });
      logger.info(`Deleted room ${targetRoomId}`, { deleted: roomDeleteResult.deletedCount });

      clearScreenShareState(targetRoomId);

      io.to(targetRoomId).emit('room_destroyed', {
        reason: 'Host ended the meeting',
        roomId: targetRoomId,
        destroyedBy: user.userId,
      });

      io.in(targetRoomId).disconnectSockets(true);

      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.del(`room:${targetRoomId}:users`);
          logger.info(`Cleaned up Redis data for room ${targetRoomId}`);
        } catch (redisError: any) {
          logger.warn('Redis cleanup failed (non-critical)', {
            error: redisError instanceof Error ? redisError.message : String(redisError),
          });
        }
      }

      logger.info(`Room ${targetRoomId} destroyed successfully by admin ${user.userId}`);
      user.roomCode = '';
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error destroying room', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: targetRoomId, userId: user.userId,
      });

      let userFriendlyMessage = 'Failed to destroy room';
      if (errorMessage.includes('not connected') || errorMessage.includes('database')) {
        userFriendlyMessage = 'Database connection error. Please try again.';
      } else if (errorMessage.includes('transaction')) {
        userFriendlyMessage = 'Database transaction failed. Please try again.';
      } else if (errorMessage.includes('permission') || errorMessage.includes('unauthorized')) {
        userFriendlyMessage = 'You are not authorized to end this meeting.';
      } else if (errorMessage) {
        userFriendlyMessage = `Failed to destroy room: ${errorMessage}`;
      }

      socket.emit('error', { message: userFriendlyMessage });
    }
  });

  // Legacy handler for backward compatibility
  socket.on('admin_close_room', async (data: { roomToken: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    if (!data || typeof data.roomToken !== 'string' || !data.roomToken.trim()) {
      socket.emit('error', { message: 'Invalid room token' });
      return;
    }

    const targetRoomId = user.roomCode;

    try {
      const room = await getRoomByCode(targetRoomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const isAdmin = verifyRoomToken(data.roomToken, targetRoomId);
      if (!isAdmin) {
        logger.warn(`Unauthorized room closure attempt by user ${user.userId} in room ${targetRoomId}`);
        socket.emit('error', { message: 'Unauthorized: Only the room creator can close the room' });
        return;
      }

      clearPendingDeletionTimer(targetRoomId);

      logger.info(`Admin ${user.userId} closing room ${targetRoomId} (legacy handler)`);

      if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected', { readyState: mongoose.connection.readyState });
        throw new Error('Database connection not available');
      }

      let cleanupResult: any;
      let useTransaction = false;

      try {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const messageDeleteResult = await MessageModel.deleteMany({ roomCode: targetRoomId }, { session });
            logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${targetRoomId}`);

            const roomDeleteResult = await RoomModel.deleteOne({ code: targetRoomId }, { session });
            logger.info(`Deleted room ${targetRoomId}`, { deleted: roomDeleteResult.deletedCount });

            cleanupResult = {
              messagesDeleted: messageDeleteResult.deletedCount,
              roomDeleted: roomDeleteResult.deletedCount,
            };
          });
          useTransaction = true;
        } catch (transactionError: any) {
          logger.warn('Transaction failed, will use direct deletes', {
            error: transactionError instanceof Error ? transactionError.message : String(transactionError),
          });
        } finally {
          await session.endSession();
        }
      } catch (sessionError: any) {
        logger.info('Cannot start session (likely not a replica set), using direct deletes', {
          error: sessionError instanceof Error ? sessionError.message : String(sessionError),
        });
      }

      if (!useTransaction) {
        logger.info('Using direct deletes (no transaction)');
        const messageDeleteResult = await MessageModel.deleteMany({ roomCode: targetRoomId });
        const roomDeleteResult = await RoomModel.deleteOne({ code: targetRoomId });
        cleanupResult = {
          messagesDeleted: messageDeleteResult.deletedCount,
          roomDeleted: roomDeleteResult.deletedCount,
        };
      }

      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.del(`room:${targetRoomId}:users`);
          const socketsInRoom = await io.in(targetRoomId).fetchSockets();
          for (const socketInRoom of socketsInRoom) {
            const socketUser = (socketInRoom as any).data?.user;
            if (socketUser?.userId) await redis.del(`user:${socketUser.userId}`);
          }
          logger.info(`Cleaned up Redis data for room ${targetRoomId}`);
        } catch (redisError: any) {
          logger.warn('Redis cleanup failed (non-critical)', {
            error: redisError instanceof Error ? redisError.message : String(redisError),
          });
        }
      }

      clearScreenShareState(targetRoomId);

      io.to(targetRoomId).emit('room_terminated', {
        reason: 'Host ended the session',
        roomId: targetRoomId,
        terminatedBy: user.userId,
      });

      const socketsInRoom = await io.in(targetRoomId).fetchSockets();
      for (const socketInRoom of socketsInRoom) {
        socketInRoom.leave(targetRoomId);
      }

      logger.info(`Room ${targetRoomId} closed successfully by admin ${user.userId}. Disconnected ${socketsInRoom.length} sockets.`, cleanupResult);

      user.roomCode = '';
    } catch (error: any) {
      logger.error('Error closing room (legacy handler)', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: targetRoomId, userId: user.userId,
      });
      socket.emit('error', { message: 'Failed to close room' });
    }
  });
};
