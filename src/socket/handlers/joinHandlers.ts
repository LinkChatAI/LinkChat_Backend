import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { getRedisClient, isRedisAvailable } from '../../config/redis.js';
import { getRoomByCode, unlockRoom } from '../../services/roomService.js';
import { getRoomMessages } from '../../services/messageService.js';
import { SocketUser } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { emitAdminInsightUpdate } from '../adminHandlers.js';
import { HandlerContext, normalizeMessages } from './types.js';
import { clearPendingDeletionTimer, hasPendingDeletion } from './roomLifecycleHandlers.js';
import { getScreenSharePublicState } from '../screenShareState.js';
import { recordFailedJoin } from '../../services/platformMetricsService.js';
import { isUserKicked } from '../../services/roomModerationService.js';
import { getStorageLimitForPlan } from '../../constants/roomStorage.js';

const getRedis = () => getRedisClient();

const waitForDatabase = async (maxRetries = 10, delayMs = 1000): Promise<boolean> => {
  for (let i = 0; i < maxRetries; i++) {
    if (mongoose.connection.readyState === 1) return true;
    if (i < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
};

const ensureNicknameUniqueInRoom = async (
  baseNickname: string,
  roomCode: string,
  excludeUserId: string,
  io: Server,
): Promise<string> => {
  const existingNicknames = new Set<string>();

  try {
    const socketsInRoom = await io.in(roomCode).fetchSockets();
    for (const socketInRoom of socketsInRoom) {
      const socketData = (socketInRoom as any).data;
      if (socketData?.user) {
        const socketUser = socketData.user as SocketUser;
        if (socketUser.userId !== excludeUserId && socketUser.nickname && socketUser.nickname !== 'Anonymous') {
          existingNicknames.add(socketUser.nickname.toLowerCase());
        }
      }
    }
  } catch (error: any) {
    logger.warn('Failed to check active sockets for nicknames', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const userIds = await redis.smembers(`room:${roomCode}:users`);
      if (userIds && userIds.length > 0) {
        for (const userId of userIds) {
          if (userId !== excludeUserId) {
            const storedNickname = await redis.hget(`user:${userId}`, 'nickname');
            if (storedNickname && storedNickname !== 'Anonymous') {
              existingNicknames.add(storedNickname.toLowerCase());
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn('Failed to check Redis for nicknames', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const { MessageModel } = await import('../../models/Message.js');
    const query: any = { roomCode };
    if (excludeUserId) query.userId = { $ne: excludeUserId };
    const distinctNicknames = await MessageModel.distinct('nickname', query).exec();
    distinctNicknames.forEach((nickname: any) => {
      if (nickname && typeof nickname === 'string' && nickname.trim() !== 'Anonymous') {
        existingNicknames.add(nickname.trim().toLowerCase());
      }
    });
  } catch (error: any) {
    logger.warn('Failed to check MongoDB for nicknames', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const baseLower = baseNickname.toLowerCase();
  if (!existingNicknames.has(baseLower)) return baseNickname;

  let attempts = 0;
  const maxAttempts = 20;
  while (attempts < maxAttempts) {
    const suffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const uniqueNickname = `${baseNickname}#${suffix}`;
    if (!existingNicknames.has(uniqueNickname.toLowerCase())) {
      logger.debug('Nickname conflict resolved with suffix', {
        original: baseNickname, unique: uniqueNickname, roomCode, excludeUserId,
      });
      return uniqueNickname;
    }
    attempts++;
  }

  const timestampSuffix = Date.now().toString().slice(-3);
  const uniqueNickname = `${baseNickname}#${timestampSuffix}`;
  logger.warn('Used timestamp suffix for nickname uniqueness after max attempts', {
    original: baseNickname, unique: uniqueNickname, roomCode, attempts: maxAttempts,
  });
  return uniqueNickname;
};

export const registerJoinHandlers = (ctx: HandlerContext): void => {
  const { io, socket, user, ensureUserInRoom, emitErrorAlert } = ctx;

  socket.on('joinRoom', async (data: { code: string; nickname?: string; senderId?: string }) => {
    try {
      if (!data || typeof data.code !== 'string' || !data.code.trim()) {
        logger.warn('Invalid joinRoom request', { data });
        recordFailedJoin();
        socket.emit('error', { message: 'Invalid room code' });
        return;
      }

      const code = data.code.trim();

      if (!/^\d+$/.test(code)) {
        logger.warn('Invalid room code format', { code });
        recordFailedJoin();
        socket.emit('error', { message: 'Invalid room code format' });
        return;
      }

      if (data.senderId && typeof data.senderId === 'string' && data.senderId.trim()) {
        user.userId = data.senderId.trim();
      }

      if (mongoose.connection.readyState !== 1) {
        logger.debug(`Database not ready, waiting for connection... (User: ${user.userId}, Room: ${code})`);
        const dbReady = await waitForDatabase();
        if (!dbReady) {
          logger.error('Database connection timeout - cannot join room', { userId: user.userId, roomCode: code });
          recordFailedJoin();
          socket.emit('error', { message: 'Database connection unavailable. Please try again in a moment.' });
          return;
        }
        logger.debug('Database connection ready, proceeding with room join');
      }

      logger.debug(`User ${user.userId} attempting to join room ${code}`);
      const room = await getRoomByCode(code);
      if (!room) {
        logger.warn(`Room ${code} not found`);
        recordFailedJoin();
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      if (new Date() > room.expiresAt) {
        logger.warn(`Room ${code} expired`);
        recordFailedJoin(true);
        socket.emit('error', { message: 'Room expired' });
        return;
      }

      const joinUserId = user.userId;
      if (isUserKicked(code, joinUserId)) {
        recordFailedJoin(true);
        socket.emit('error', { message: 'You were removed from this room by the host' });
        return;
      }

      let nickname: string;
      if (data.nickname && typeof data.nickname === 'string' && data.nickname.trim()) {
        const providedNickname = sanitizeName(data.nickname.trim());
        nickname = await ensureNicknameUniqueInRoom(providedNickname, code, user.userId, io);
        if (nickname !== providedNickname) {
          logger.info('Provided nickname had conflict, appended suffix', {
            original: providedNickname, unique: nickname, roomCode: code, userId: user.userId,
          });
        }
      } else {
        try {
          const { generateUniqueNicknameForRoom } = await import('../../utils/nickname.js');
          const baseNickname = await generateUniqueNicknameForRoom(code);
          nickname = await ensureNicknameUniqueInRoom(baseNickname, code, user.userId, io);
          logger.debug('Generated unique nickname for room', { nickname, roomCode: code, userId: user.userId });
        } catch (error: any) {
          logger.warn('Failed to generate unique nickname, using Anonymous', {
            error: error instanceof Error ? error.message : String(error),
            roomCode: code,
          });
          nickname = 'Anonymous';
        }
      }

      user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}&background=2563eb&color=fff`;

      if (user.roomCode && user.roomCode !== code) {
        socket.leave(user.roomCode);
      }

      user.roomCode = code;
      user.nickname = nickname;
      (socket as any).data = { user };
      socket.join(code);

      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.sadd(`room:${data.code}:users`, user.userId);
          await redis.hset(`user:${user.userId}`, {
            nickname: user.nickname,
            roomCode: data.code,
          });
        } catch (error: any) {
          // Ignore Redis errors
        }
      }

      const authUserId = socket.handshake.auth?.userId || user.userId;
      const isOwner = room.ownerId && room.ownerId === authUserId;

      if (isOwner && hasPendingDeletion(code)) {
        logger.info(`Admin ${authUserId} reconnected to room ${code} - clearing pending deletion timer`);
        clearPendingDeletionTimer(code);
        io.to(code).emit('adminBack', {
          roomId: code,
          message: 'Admin has reconnected. Room is active again.',
        });
      }

      let activeRoom = room;
      if (isOwner && room.isLocked) {
        logger.info(`Host ${authUserId} rejoined locked room ${code} - unlocking`);
        activeRoom = await unlockRoom(code);
        io.to(code).emit('room_unlocked', { roomId: code });
        io.to(code).emit('adminBack', {
          roomId: code,
          message: 'Host is back; chat reopened.',
        });
      }

      const messages = await getRoomMessages(code);
      const normalizedMessages = normalizeMessages(messages);
      socket.emit('roomJoined', {
        messages: normalizedMessages,
        userId: user.userId,
        nickname: user.nickname,
        isLocked: activeRoom.isLocked || false,
        lockedAt: activeRoom.lockedAt ? activeRoom.lockedAt.toISOString() : undefined,
        ownerId: activeRoom.ownerId,
        coHostIds: activeRoom.coHostIds || [],
        slowModeMessagesPerMinute: activeRoom.slowModeMessagesPerMinute ?? 0,
        screenShare: getScreenSharePublicState(code),
        storageUsed: activeRoom.storageUsed || 0,
        storageLimitBytes: getStorageLimitForPlan(activeRoom.plan as string | undefined),
      });
      socket.to(code).emit('userJoined', { userId: user.userId, nickname: user.nickname });

      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${code}:users`);
        } catch (error: any) {
          userCount = io.sockets.adapter.rooms.get(code)?.size || 0;
        }
      } else {
        userCount = io.sockets.adapter.rooms.get(code)?.size || 0;
      }
      io.to(code).emit('userCount', { count: userCount });
      logger.info(`User ${user.userId} joined room ${code}`);

      try {
        const { UserVisitModel } = await import('../../models/UserVisit.js');
        const { GlobalStatsModel } = await import('../../models/GlobalStats.js');

        await UserVisitModel.create({
          userId: user.userId,
          roomCode: code,
          nickname: user.nickname,
          joinedAt: new Date(),
        });

        await GlobalStatsModel.findOneAndUpdate(
          { key: 'totalVisitsLifetime' },
          { $inc: { value: 1 }, $set: { lastUpdated: new Date() } },
          { upsert: true, new: true }
        );
      } catch (visitError: any) {
        logger.warn('Failed to track user visit', {
          error: visitError instanceof Error ? visitError.message : String(visitError),
          userId: user.userId, roomCode: code,
        });
      }

      emitAdminInsightUpdate(io, 'user_joined', { roomCode: code, userId: user.userId }).catch(err => {
        logger.warn('Failed to emit admin insight update for user join', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (error: any) {
      logger.error('Error joining room:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      socket.emit('error', {
        message: error instanceof Error ? error.message : 'Failed to join room',
      });
    }
  });

  socket.on('update_nickname', async (data: { newName: string }) => {
    try {
      if (!ensureUserInRoom()) {
        socket.emit('error_alert', { message: 'Not in a room' });
        return;
      }

      if (!data || typeof data.newName !== 'string' || !data.newName.trim()) {
        socket.emit('error_alert', { message: 'Invalid nickname' });
        return;
      }

      const newName = data.newName.trim();
      if (newName.length < 3 || newName.length > 15) {
        socket.emit('error_alert', { message: 'Nickname must be 3-15 characters' });
        return;
      }

      if (!/^[a-zA-Z0-9]+$/.test(newName)) {
        socket.emit('error_alert', { message: 'Nickname must contain only letters and numbers' });
        return;
      }

      const sanitizedNickname = sanitizeName(newName);
      const uniqueNickname = await ensureNicknameUniqueInRoom(sanitizedNickname, user.roomCode, user.userId, io);

      const oldNickname = user.nickname;
      user.nickname = uniqueNickname;
      user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(uniqueNickname)}&background=2563eb&color=fff`;
      (socket as any).data = { user };

      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.hset(`user:${user.userId}`, {
            nickname: user.nickname,
            roomCode: user.roomCode,
          });
        } catch (error: any) {
          logger.warn('Failed to update nickname in Redis', { error });
        }
      }

      const { MessageModel } = await import('../../models/Message.js');
      try {
        await MessageModel.updateMany(
          { roomCode: user.roomCode, userId: user.userId },
          { $set: { nickname: uniqueNickname, avatar: user.avatar } }
        );
      } catch (error: any) {
        logger.warn('Failed to update messages with new nickname', { error });
      }

      io.to(user.roomCode).emit('room_user_updated', {
        userId: user.userId,
        nickname: uniqueNickname,
        avatar: user.avatar,
      });

      logger.info(`User ${user.userId} updated nickname from "${oldNickname}" to "${uniqueNickname}" in room ${user.roomCode}`);
    } catch (error: any) {
      emitErrorAlert(error, 'Failed to update nickname');
    }
  });
};
