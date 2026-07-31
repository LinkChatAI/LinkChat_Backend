import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { getRedisClient, isRedisAvailable } from '../../config/redis.js';
import { getRoomByCode, verifyRoomToken, lockRoom } from '../../services/roomService.js';
import { getSettingsSync } from '../../services/adminSettingsService.js';
import { createMessage } from '../../services/messageService.js';
import { logger } from '../../utils/logger.js';
import { MessageModel } from '../../models/Message.js';
import { RoomModel } from '../../models/Room.js';
import { emitAdminInsightUpdate } from '../adminHandlers.js';
import { HandlerContext } from './types.js';
import { getCachedRoomSockets, getCachedRoomSocketCount } from './socketCache.js';
import { setRoomParticipantCount } from '../../services/metricsService.js';
import { purgeRoom, isRoomPurging } from '../../services/roomPurgeService.js';
import {
  hasPendingDeletion,
  clearPendingDeletionTimer,
  setPendingDeletionTimer,
  forgetPendingDeletionTimer,
  hasPendingUserLeaveTimer,
  clearPendingUserLeaveTimer,
  setPendingUserLeaveTimer,
  forgetPendingUserLeaveTimer,
} from './roomTimers.js';
import { handleScreenShareParticipantLeft, stopScreenSharePresentation } from '../screenShareService.js';

const getRedis = () => getRedisClient();

// Timer registries live in ./roomTimers so the purge service can cancel them
// without importing this module (which imports the purge service). Re-exported
// here to keep the existing import sites working.
export {
  hasPendingDeletion,
  clearPendingDeletionTimer,
  hasPendingUserLeaveTimer,
  clearPendingUserLeaveTimer,
};

/**
 * Admin-leave grace period, in minutes — configurable via the admin dashboard
 * (Settings → Room Lifecycle Rules), defaulting to 60 (the old hardcoded
 * value) when nothing has been configured yet or the settings cache hasn't
 * warmed up.
 */
const getAdminGraceMinutes = (): number => getSettingsSync().adminLeaveGraceMinutes || 60;

/** e.g. 90 -> "1h 30m", 60 -> "1 hour", 20 -> "20 minutes" */
const formatGraceDuration = (minutes: number): string => {
  if (!minutes || minutes <= 0) return 'a short grace period';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

// Grace-period timers for non-admin participants who disconnect (mobile app
// switch, brief network drop, tab close without an explicit leave). Mirrors
// the admin pendingDeletionTimers pattern above but scoped per user+room and
// on a much shorter fuse — we defer actually removing them from the room
// instead of doing it the instant the transport drops, so a reconnect within
// the window (recovered silently or via full rejoin) never shows them as
// having left and never frees their nickname out from under them.
const USER_LEAVE_GRACE_MS = 20 * 60 * 1000; // 20 minutes

const destroyRoomAfterGracePeriod = async (
  io: Server,
  roomCode: string,
  adminUserId: string,
  graceLabel: string
): Promise<void> => {
  try {
    logger.info(`Grace period expired for room ${roomCode}, destroying room`);

    forgetPendingDeletionTimer(roomCode);

    const room = await getRoomByCode(roomCode);
    if (!room) {
      logger.info(`Room ${roomCode} already deleted, skipping destruction`);
      return;
    }

    if (mongoose.connection.readyState !== 1) {
      logger.error('Database not connected during grace period expiration', { readyState: mongoose.connection.readyState });
      return;
    }

    await purgeRoom(roomCode, {
      reason: `Host did not return within ${graceLabel}. Room has been closed.`,
      trigger: 'host-grace-expired',
      event: 'room_vanished',
      actorId: adminUserId,
      systemMessage: `Host did not return within ${graceLabel}. Room has been closed.`,
    });

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

    // A ghost never entered Redis/broadcasts on join, so mirror that exactly
    // on the way out — same object as ctx.user, so this is already resolved
    // by the time a leave can happen (joinRoom awaits ghostReady first).
    const isGhost = user.isGhost === true;

    try {
      handleScreenShareParticipantLeft(io, roomCodeToLeave, userId);

      const redis = getRedis();

      if (!isGhost && redis && isRedisAvailable()) {
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
      if (!isGhost) {
        socket.to(roomCodeToLeave).emit('user_left', { userId, roomId: roomCodeToLeave });
      }

      // Ghost was never counted, so the count hasn't actually changed — skip
      // the broadcast rather than re-emitting the same number.
      if (!isGhost) {
        let userCount = 0;
        if (redis && isRedisAvailable()) {
          try {
            userCount = await redis.scard(`room:${roomCodeToLeave}:users`);
          } catch (error: any) {
            // Redis errored mid-call — fetchSockets() is accurate across instances
            // (unlike io.sockets.adapter.rooms, which only reflects this instance).
            userCount = await getCachedRoomSocketCount(io, roomCodeToLeave);
          }
        } else {
          userCount = await getCachedRoomSocketCount(io, roomCodeToLeave);
        }
        io.to(roomCodeToLeave).emit('userCount', { count: userCount });
        setRoomParticipantCount(roomCodeToLeave, userCount);
      }

      if (shouldEmitRoomLeft) {
        socket.emit('roomLeft', { roomId: roomCodeToLeave });
      }

      logger.info(`${isGhost ? 'Ghost admin' : 'User'} ${userId} left room ${roomCodeToLeave}`);

      if (!isGhost) {
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
        // Admin intentionally leaving — start the configurable grace period (same as disconnect).
        // Room is NOT locked; admin can rejoin within the window and resume as host.
        const graceMinutes = getAdminGraceMinutes();
        const graceLabel = formatGraceDuration(graceMinutes);
        logger.info(`Admin ${authUserId} leaving room ${roomId} - starting ${graceLabel} grace period`);
        clearPendingDeletionTimer(roomId);

        const gracePeriodMs = graceMinutes * 60_000;
        const capturedRoomId = roomId;
        const timer = setTimeout(() => {
          destroyRoomAfterGracePeriod(io, capturedRoomId, authUserId, graceLabel).catch(err => {
            logger.error('Error in destroyRoomAfterGracePeriod (leave_room)', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, gracePeriodMs);
        setPendingDeletionTimer(capturedRoomId, timer);

        stopScreenSharePresentation(io, roomId, authUserId, 'Host left the room');

        io.to(roomId).emit('adminOffline', {
          roomId,
          message: `Host has left. Room will close in ${graceLabel} if host does not return.`,
          gracePeriodSeconds: gracePeriodMs / 1000,
        });

        logger.info(`Grace period timer started for room ${roomId}, expires in ${graceLabel}`);
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
          const graceMinutes = getAdminGraceMinutes();
          const graceLabel = formatGraceDuration(graceMinutes);
          logger.info(`Admin ${authUserId} disconnected from room ${user.roomCode} - starting ${graceLabel} grace period`);
          clearPendingDeletionTimer(user.roomCode);

          // Capture by value before user.roomCode is cleared below
          const roomCodeForTimer = user.roomCode;
          const gracePeriodMs = graceMinutes * 60_000; // admin can rejoin within this window and resume as host
          const timer = setTimeout(() => {
            destroyRoomAfterGracePeriod(io, roomCodeForTimer, authUserId, graceLabel).catch(err => {
              logger.error('Error in destroyRoomAfterGracePeriod', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }, gracePeriodMs);

          setPendingDeletionTimer(roomCodeForTimer, timer);

          io.to(roomCodeForTimer).emit('adminOffline', {
            roomId: roomCodeForTimer,
            message: `Host disconnected. Room will close in ${graceLabel} if host does not return.`,
            gracePeriodSeconds: gracePeriodMs / 1000,
          });

          logger.info(`Grace period timer started for room ${roomCodeForTimer}, expires in ${graceLabel}`);
        } else {
          // Don't remove the participant the instant the transport drops — mobile
          // backgrounding/app-switching and brief network blips look identical to a
          // real leave at this point. Give them a grace window to reconnect (silent
          // recovery or a full rejoin both clear this timer) before actually
          // tearing down their room membership/nickname reservation.
          const roomCodeForUserTimer = user.roomCode;
          const userIdForTimer = user.userId;
          clearPendingUserLeaveTimer(roomCodeForUserTimer, userIdForTimer);

          // A purge force-disconnects everyone, which lands here. Registering a
          // 20-minute leave timer for a room that is being torn down would
          // outlive the room — and because room codes are recycled, it would
          // eventually fire against whichever room next holds this code.
          //
          // `!room` is checked alongside the purging flag on purpose: the flag
          // is held for a short window after teardown, and the code can be
          // reissued inside that window. If a room document exists under this
          // code it is a DIFFERENT room, and that room's participants still
          // need their normal grace-period handling.
          if (isRoomPurging(roomCodeForUserTimer) && !room) {
            user.roomCode = '';
            return;
          }

          const timer = setTimeout(() => {
            forgetPendingUserLeaveTimer(roomCodeForUserTimer, userIdForTimer);
            (async () => {
              try {
                // Guard against a still-connected second tab/device for the same
                // user — don't punish them for one connection dropping if another
                // is still active in the room.
                const stillPresent = (await getCachedRoomSockets(io, roomCodeForUserTimer)).some(
                  (s: any) => s.data?.user?.userId === userIdForTimer
                );
                if (stillPresent) return;
                await handleUserLeaveRoom(roomCodeForUserTimer, userIdForTimer, false);
              } catch (err: any) {
                logger.error('Error running deferred user leave', {
                  error: err instanceof Error ? err.message : String(err),
                  roomCode: roomCodeForUserTimer, userId: userIdForTimer,
                });
              }
            })();
          }, USER_LEAVE_GRACE_MS);

          setPendingUserLeaveTimer(roomCodeForUserTimer, userIdForTimer, timer);
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

      const purgeResult = await purgeRoom(targetRoomId, {
        reason: 'The owner has vanished the room.',
        trigger: 'owner',
        event: 'room_vanished',
        actorId: user.userId,
        systemMessage: 'The owner has vanished the room.',
      });

      logger.info(`Room ${targetRoomId} terminated successfully by admin ${user.userId}. Disconnected ${purgeResult.socketsDisconnected} sockets.`);

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

      // Previously this path deleted only messages + the room document: no
      // file deletion at all, and Redis cleanup limited to the member set.
      // Routing it through purgeRoom is what closes that gap.
      await purgeRoom(targetRoomId, {
        reason: 'Host ended the meeting',
        trigger: 'owner',
        event: 'room_destroyed',
        actorId: user.userId,
      });

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

      // The old transaction-with-fallback here only ever wrapped the two Mongo
      // deletes, so it bought atomicity across the two cheapest steps while
      // files, Redis and in-memory state stayed outside it anyway — and this
      // path deleted no files at all and never force-disconnected anyone.
      const cleanupResult = await purgeRoom(targetRoomId, {
        reason: 'Host ended the session',
        trigger: 'owner',
        event: 'room_terminated',
        actorId: user.userId,
      });

      logger.info(
        `Room ${targetRoomId} closed successfully by admin ${user.userId}. Disconnected ${cleanupResult.socketsDisconnected} sockets.`,
        {
          messagesDeleted: cleanupResult.messagesDeleted,
          roomDeleted: cleanupResult.roomDeleted,
        },
      );

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
