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
import { clearRoomModeration } from '../../services/roomModerationService.js';
import { clearSlowModeForRoom } from '../../services/slowModeService.js';
import { clearRoomReceipts } from '../../services/readReceiptService.js';
import { getCachedRoomSockets } from './socketCache.js';
import { setRoomParticipantCount } from '../../services/metricsService.js';

const clearAllRoomState = (roomCode: string): void => {
  clearScreenShareState(roomCode);
  clearRoomModeration(roomCode);
  clearSlowModeForRoom(roomCode);
  clearRoomReceipts(roomCode);
};
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
        'Host did not return within 1 hour. Room has been closed.', 'text'
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

    clearAllRoomState(roomCode);

    io.to(roomCode).emit('room_vanished', {
      reason: 'Host did not return within 1 hour. Room has been closed.',
      roomId: roomCode,
      vanishedBy: adminUserId,
    });

    // Collect user IDs BEFORE disconnecting so Redis cleanup can find them
    const socketsInRoom = await io.in(roomCode).fetchSockets();
    const userIdsToClean = socketsInRoom
      .map((s: any) => s.data?.user?.userId as string | undefined)
      .filter((id): id is string => !!id);

    for (const socketInRoom of socketsInRoom) {
      socketInRoom.leave(roomCode);
    }
    io.in(roomCode).disconnectSockets(true);

    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      try {
        await redis.del(`room:${roomCode}:users`);
        for (const uid of userIdsToClean) {
          await redis.del(`user:${uid}`);
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
          // Free up the nickname slot so it doesn't sit reserved for the rest of
          // the room's 6h TTL — otherwise long-running, high-churn rooms
          // accumulate stale reservations and push future joins into the
          // suffix-retry loop for no reason.
          if (user.nickname) {
            await redis.srem(`room:${roomCodeToLeave}:nicknames`, user.nickname.toLowerCase());
          }
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
          // Redis errored mid-call — fetchSockets() is accurate across instances
          // (unlike io.sockets.adapter.rooms, which only reflects this instance).
          userCount = (await getCachedRoomSockets(io, roomCodeToLeave)).length;
        }
      } else {
        userCount = (await getCachedRoomSockets(io, roomCodeToLeave)).length;
      }
      io.to(roomCodeToLeave).emit('userCount', { count: userCount });
      setRoomParticipantCount(roomCodeToLeave, userCount);

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
        // Admin intentionally leaving — start 1-hour grace period (same as disconnect).
        // Room is NOT locked; admin can rejoin within 1 hour and resume as host.
        logger.info(`Admin ${authUserId} leaving room ${roomId} - starting 1-hour grace period`);
        clearPendingDeletionTimer(roomId);

        const gracePeriodMs = 3_600_000; // 1 hour
        const capturedRoomId = roomId;
        const timer = setTimeout(() => {
          destroyRoomAfterGracePeriod(io, capturedRoomId, authUserId).catch(err => {
            logger.error('Error in destroyRoomAfterGracePeriod (leave_room)', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, gracePeriodMs);
        pendingDeletionTimers.set(capturedRoomId, timer);

        stopScreenSharePresentation(io, roomId, authUserId, 'Host left the room');

        io.to(roomId).emit('adminOffline', {
          roomId,
          message: 'Host has left. Room will close in 1 hour if host does not return.',
          gracePeriodSeconds: 3600,
        });

        logger.info(`Grace period timer started for room ${roomId}, expires in 1 hour`);
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
    // Clear any pending typing timers for this user to avoid post-disconnect broadcasts
    const typingKey = `${user.roomCode}:${user.userId}`;
    const typingTimer = ctx.typingUsers.get(typingKey);
    if (typingTimer) {
      clearTimeout(typingTimer);
      ctx.typingUsers.delete(typingKey);
      if (user.roomCode) {
        socket.to(user.roomCode).emit('userStoppedTyping', { userId: user.userId });
      }
    }

    if (user.roomCode) {
      logger.debug(`User ${user.userId} disconnecting from room ${user.roomCode}`);
      try {
        const authUserId = socket.handshake.auth?.userId || user.userId;
        const room = await getRoomByCode(user.roomCode);

        if (room && room.ownerId && room.ownerId === authUserId && !room.isLocked && !room.isEnded) {
          logger.info(`Admin ${authUserId} disconnected from room ${user.roomCode} - starting 1-hour grace period`);
          clearPendingDeletionTimer(user.roomCode);

          // Capture by value before user.roomCode is cleared below
          const roomCodeForTimer = user.roomCode;
          const gracePeriodMs = 3_600_000; // 1 hour — admin can rejoin and resume as host
          const timer = setTimeout(() => {
            destroyRoomAfterGracePeriod(io, roomCodeForTimer, authUserId).catch(err => {
              logger.error('Error in destroyRoomAfterGracePeriod', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }, gracePeriodMs);

          pendingDeletionTimers.set(roomCodeForTimer, timer);

          io.to(roomCodeForTimer).emit('adminOffline', {
            roomId: roomCodeForTimer,
            message: 'Host disconnected. Room will close in 1 hour if host does not return.',
            gracePeriodSeconds: 3600,
          });

          logger.info(`Grace period timer started for room ${roomCodeForTimer}, expires in 1 hour`);
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
      const room = await getRoomByCode(user.roomCode);
      const authUserId = socket.handshake.auth?.userId || user.userId;
      if (!room || !room.ownerId || room.ownerId !== authUserId) {
        socket.emit('error', { message: 'Unauthorized: Only the room creator can end the room' });
        return;
      }
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

      clearAllRoomState(targetRoomId);

      io.to(targetRoomId).emit('room_vanished', {
        reason: 'The owner has vanished the room.',
        roomId: targetRoomId,
        vanishedBy: user.userId,
      });

      // Collect user IDs BEFORE disconnecting so Redis cleanup can find them
      const socketsInRoom = await io.in(targetRoomId).fetchSockets();
      const userIdsToClean = socketsInRoom
        .map((s: any) => s.data?.user?.userId as string | undefined)
        .filter((id): id is string => !!id);

      for (const socketInRoom of socketsInRoom) {
        socketInRoom.leave(targetRoomId);
      }
      io.in(targetRoomId).disconnectSockets(true);

      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.del(`room:${targetRoomId}:users`);
          for (const uid of userIdsToClean) {
            await redis.del(`user:${uid}`);
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

      clearAllRoomState(targetRoomId);

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

      clearAllRoomState(targetRoomId);

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
