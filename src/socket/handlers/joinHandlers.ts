import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { getRedisClient, isRedisAvailable } from '../../config/redis.js';
import { getRoomByCode, unlockRoom } from '../../services/roomService.js';
import { getRoomMessages } from '../../services/messageService.js';
import { SocketUser } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { emitAdminInsightUpdate } from '../adminHandlers.js';
import { HandlerContext, stripHeavyContentForJoin } from './types.js';
import { clearPendingDeletionTimer, hasPendingDeletion, clearPendingUserLeaveTimer } from './roomLifecycleHandlers.js';
import { getScreenSharePublicState } from '../screenShareState.js';
import { recordFailedJoin } from '../../services/platformMetricsService.js';
import { isUserKicked } from '../../services/roomModerationService.js';
import { getStorageLimitForPlan } from '../../constants/roomStorage.js';
import type { RoomBannerPayload } from '../../services/roomBannerBroadcast.js';
import { getCachedRoomSockets, getCachedRoomSocketCount } from './socketCache.js';
import { setRoomParticipantCount } from '../../services/metricsService.js';
import { recordPeakConcurrent, recordUniqueVisitor } from '../../services/dailyStatsService.js';
import { getSettingsSync } from '../../services/adminSettingsService.js';
import { getLiveUserCountsForRooms } from '../../services/roomPresenceService.js';

const getRedis = () => getRedisClient();

const getOnlineParticipantSnapshots = async (
  io: Server,
  roomCode: string,
): Promise<Array<{ userId: string; nickname: string }>> => {
  const participants: Array<{ userId: string; nickname: string }> = [];
  const seen = new Set<string>();

  try {
    const sockets = await getCachedRoomSockets(io, roomCode);
    for (const s of sockets) {
      const su = (s as { data?: { user?: SocketUser } }).data?.user;
      if (!su?.userId || su.isGhost || seen.has(su.userId)) continue;
      seen.add(su.userId);
      participants.push({
        userId: su.userId,
        nickname: su.nickname || 'Anonymous',
      });
    }
  } catch (error: unknown) {
    logger.warn('Failed to list online participants on join', {
      error: error instanceof Error ? error.message : String(error),
      roomCode,
    });
  }

  return participants;
};

const waitForDatabase = async (maxRetries = 10, delayMs = 1000): Promise<boolean> => {
  for (let i = 0; i < maxRetries; i++) {
    if (mongoose.connection.readyState === 1) return true;
    if (i < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
};

/**
 * Expensive, multi-source reconstruction of nicknames already in use in a room
 * (live sockets + message history). Only needed when Redis is unavailable —
 * when Redis is up, the atomic `room:{code}:nicknames` SADD in `tryReserve`
 * below is the real source of truth and this whole scan can be skipped.
 */
const buildExistingNicknamesFallback = async (
  roomCode: string,
  excludeUserId: string,
  io: Server,
): Promise<Set<string>> => {
  const existingNicknames = new Set<string>();

  try {
    const socketsInRoom = await io.in(roomCode).fetchSockets();
    for (const socketInRoom of socketsInRoom) {
      const socketData = (socketInRoom as any).data;
      if (socketData?.user) {
        const socketUser = socketData.user as SocketUser;
        if (socketUser.userId !== excludeUserId && !socketUser.isGhost && socketUser.nickname && socketUser.nickname !== 'Anonymous') {
          existingNicknames.add(socketUser.nickname.toLowerCase());
        }
      }
    }
  } catch (error: any) {
    logger.warn('Failed to check active sockets for nicknames', {
      error: error instanceof Error ? error.message : String(error),
    });
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

  return existingNicknames;
};

const ensureNicknameUniqueInRoom = async (
  baseNickname: string,
  roomCode: string,
  excludeUserId: string,
  io: Server,
): Promise<string> => {
  const redis = getRedis();
  const redisReady = !!redis && isRedisAvailable();

  // When Redis is up, skip the fetchSockets()/Redis-hget-loop/Mongo-distinct
  // reconstruction entirely — `tryReserve` below atomically SADDs into
  // `room:{code}:nicknames`, which is already the authoritative record of every
  // nickname reserved in this room, so a collision surfaces for free via SADD's
  // return value instead of needing a per-join O(N) pre-check.
  const existingNicknames = redisReady
    ? new Set<string>()
    : await buildExistingNicknamesFallback(roomCode, excludeUserId, io);

  const baseLower = baseNickname.toLowerCase();

  const tryReserve = async (candidate: string): Promise<string | null> => {
    // Atomic Redis reservation — prevents concurrent-join race where two users
    // both read the same nickname set before either has written their choice.
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      try {
        const added = await redis.sadd(`room:${roomCode}:nicknames`, candidate.toLowerCase());
        if (added === 1) {
          // Successfully reserved — set TTL to 6 hours
          redis.expire(`room:${roomCode}:nicknames`, 21600).catch(() => {});
          return candidate;
        }
        return null; // Someone else took it concurrently
      } catch {
        // Redis unavailable — fall back to in-memory check only
      }
    }
    return existingNicknames.has(candidate.toLowerCase()) ? null : candidate;
  };

  if (!existingNicknames.has(baseLower)) {
    const reserved = await tryReserve(baseNickname);
    if (reserved) return reserved;
  }

  let attempts = 0;
  const maxAttempts = 20;
  while (attempts < maxAttempts) {
    const suffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const candidate = `${baseNickname}#${suffix}`;
    if (!existingNicknames.has(candidate.toLowerCase())) {
      const reserved = await tryReserve(candidate);
      if (reserved) {
        logger.debug('Nickname conflict resolved with suffix', {
          original: baseNickname, unique: reserved, roomCode, excludeUserId,
        });
        return reserved;
      }
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
  const { io, socket, user, ensureUserInRoom, emitErrorAlert, ghostReady } = ctx;

  socket.on('joinRoom', async (data: { code: string; nickname?: string; senderId?: string }) => {
    try {
      // Must resolve before any of the isGhost checks below run — see
      // HandlerContext.ghostReady for why this isn't awaited at connect time.
      await ghostReady;

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
      if (!user.isGhost && isUserKicked(code, joinUserId)) {
        recordFailedJoin(true);
        socket.emit('error', { message: 'You were removed from this room by the host' });
        return;
      }

      // Participant cap (admin dashboard → Settings; 0 = unlimited, the
      // historical behaviour). Reads the in-process settings cache, then one
      // pipelined Redis SCARD that the join path already performs elsewhere —
      // no Mongo round trip is added. Ghosts and the owner always bypass, so
      // a full room can never lock out its own host.
      const participantCap = getSettingsSync().maxParticipantsPerRoom;
      if (participantCap > 0 && !user.isGhost && room.ownerId !== joinUserId) {
        try {
          const counts = await getLiveUserCountsForRooms(io, [code]);
          const current = counts.get(code) ?? 0;
          if (current >= participantCap) {
            recordFailedJoin(true);
            socket.emit('error', {
              message: `This room is full (${participantCap} participant limit).`,
            });
            return;
          }
        } catch {
          // Presence lookup failed — fail open rather than block a legitimate
          // join on a Redis blip. Consistent with the platform's Redis policy.
        }
      }

      // Join lock: block genuinely new participants when host has locked the room to new joiners.
      // Existing participants (who were already in this room's Redis member set) are allowed through.
      // Ghost Mode always bypasses the lock — a Super Admin monitoring a room is never a "new participant".
      const authUserId = socket.handshake.auth?.userId || joinUserId;
      const isOwnerJoining = room.ownerId && room.ownerId === authUserId;
      if (!user.isGhost && room.joinLocked && !isOwnerJoining) {
        // Check if this user has previously been in the room (Redis set)
        let isReturningParticipant = false;
        const redis = getRedis();
        if (redis && isRedisAvailable()) {
          try {
            isReturningParticipant = !!(await redis.sismember(`room:${code}:users`, joinUserId));
          } catch {
            // Redis unavailable — fall back to socket check
            const sockets = await io.in(code).fetchSockets();
            isReturningParticipant = sockets.some((s: any) => s.data?.user?.userId === joinUserId);
          }
        } else {
          // No Redis — check current sockets
          const sockets = await io.in(code).fetchSockets();
          isReturningParticipant = sockets.some((s: any) => s.data?.user?.userId === joinUserId);
        }

        if (!isReturningParticipant) {
          recordFailedJoin(true);
          socket.emit('error', { message: 'This room is currently closed to new participants.' });
          return;
        }
      }

      let nickname: string;
      if (user.isGhost) {
        // No Redis nickname reservation — a ghost never appears in any
        // participant-facing list, so it can never collide with (or take up)
        // a real nickname slot in the room.
        nickname = 'Ghost Admin';
      } else if (data.nickname && typeof data.nickname === 'string' && data.nickname.trim()) {
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
      // A pending grace-period removal (started on a prior disconnect for this
      // same user+room) is now moot — they're back.
      clearPendingUserLeaveTimer(code, user.userId);

      const redis = getRedis();
      if (!user.isGhost && redis && isRedisAvailable()) {
        try {
          await redis.sadd(`room:${code}:users`, user.userId);
          await redis.hset(`user:${user.userId}`, {
            nickname: user.nickname,
            roomCode: code,
          });
        } catch (error: any) {
          // Ignore Redis errors
        }
      }

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
      const normalizedMessages = stripHeavyContentForJoin(messages);
      const participants = await getOnlineParticipantSnapshots(io, code);

      // Best-effort — a banner lookup failure should never block a room join.
      let banner: RoomBannerPayload | null = null;
      try {
        const { resolveRoomBanner } = await import('../../services/roomBannerBroadcast.js');
        banner = await resolveRoomBanner(code);
      } catch (bannerError: unknown) {
        logger.warn('Failed to load room banner on join', {
          error: bannerError instanceof Error ? bannerError.message : String(bannerError),
          roomCode: code,
        });
      }

      socket.emit('roomJoined', {
        messages: normalizedMessages,
        userId: user.userId,
        nickname: user.nickname,
        isLocked: activeRoom.isLocked || false,
        lockedAt: activeRoom.lockedAt ? activeRoom.lockedAt.toISOString() : undefined,
        ownerId: activeRoom.ownerId,
        coHostIds: activeRoom.coHostIds || [],
        slowModeMessagesPerMinute: activeRoom.slowModeMessagesPerMinute ?? 0,
        participantsCanSend: activeRoom.participantsCanSend !== false,
        joinLocked: activeRoom.joinLocked === true,
        screenShare: getScreenSharePublicState(code),
        storageUsed: activeRoom.storageUsed || 0,
        storageLimitBytes: getStorageLimitForPlan(activeRoom.plan as string | undefined),
        participants,
        banner,
      });
      if (!user.isGhost) {
        socket.to(code).emit('userJoined', { userId: user.userId, nickname: user.nickname });
      }

      // A ghost was never added to the Redis member set (or counted by the
      // fallback), so the count genuinely hasn't changed for everyone else —
      // but the ghost's own client still needs the real number for
      // monitoring, it just must never be broadcast to (or attributed to)
      // anyone else. Always compute it; branch only on delivery.
      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${code}:users`);
        } catch (error: any) {
          // Redis errored mid-call — fetchSockets() is accurate across instances
          // (unlike io.sockets.adapter.rooms, which only reflects this instance).
          userCount = await getCachedRoomSocketCount(io, code);
        }
      } else {
        userCount = await getCachedRoomSocketCount(io, code);
      }

      if (!user.isGhost) {
        io.to(code).emit('userCount', { count: userCount });
        setRoomParticipantCount(code, userCount);
        recordPeakConcurrent(userCount).catch(() => {});
      } else {
        // Ghost-only delivery — no room broadcast, no room-level metric
        // writes (the real count hasn't changed, so those already reflect it).
        socket.emit('userCount', { count: userCount });
      }
      logger.info(`${user.isGhost ? 'Ghost admin' : 'User'} ${user.userId} joined room ${code}`);

      // Ghost joins are excluded from visit analytics, global stats, and the
      // admin insight feed entirely — a monitoring Super Admin must leave no
      // trace, including in the platform's own internal dashboards.
      if (!user.isGhost) {
        try {
          const { UserVisitModel } = await import('../../models/UserVisit.js');
          const { GlobalStatsModel } = await import('../../models/GlobalStats.js');
          const { getSocketClientIp } = await import('../../utils/socketIp.js');
          const { resolveGeoIp } = await import('../../services/geoIpService.js');

          const visit = await UserVisitModel.create({
            userId: user.userId,
            roomCode: code,
            nickname: user.nickname,
            joinedAt: new Date(),
          });

          // Resolve approximate (city-level) location from the public IP in the background —
          // never blocks the join flow, and never uses browser GPS.
          const clientIp = getSocketClientIp(socket);
          resolveGeoIp(clientIp)
            .then((geo) => {
              if (!geo) return;
              return UserVisitModel.findByIdAndUpdate(visit._id, {
                ipAddress: geo.ip,
                city: geo.city,
                region: geo.region,
                country: geo.country,
                lat: geo.lat,
                lon: geo.lon,
              }).exec();
            })
            .catch((geoError: unknown) => {
              logger.warn('GeoIP enrichment failed for user visit', {
                error: geoError instanceof Error ? geoError.message : String(geoError),
                userId: user.userId,
              });
            });

          await GlobalStatsModel.findOneAndUpdate(
            { key: 'totalVisitsLifetime' },
            { $inc: { value: 1 }, $set: { lastUpdated: new Date() } },
            { upsert: true, new: true }
          );
          recordUniqueVisitor(user.userId).catch(() => {});
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
      }
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
