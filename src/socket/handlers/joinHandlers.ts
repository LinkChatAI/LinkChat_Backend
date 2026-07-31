import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { getRedisClient, isRedisAvailable } from '../../config/redis.js';
import { getRoomByCode, unlockRoom } from '../../services/roomService.js';
import { getRoomMessages } from '../../services/messageService.js';
import { SocketUser } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { sanitizeName } from '../../utils/sanitize.js';
import {
  generateUniqueNicknameForRoom,
  isValidNicknameFormat,
  NICKNAME_FORMAT_ERROR,
  NICKNAME_MAX_LENGTH,
  shuffleNicknamePool,
} from '../../utils/nickname.js';
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
 * TTL for a room's Redis keys: the room's remaining lifetime plus a generous
 * margin, so the keys always outlive legitimate use but can never outlive the
 * room indefinitely. Clamped at both ends — an already-expired or absurdly
 * long-lived room (admin "extend" allows up to 720h) must still yield a sane,
 * bounded TTL.
 */
const REDIS_KEY_TTL_MARGIN_S = 6 * 60 * 60; // 6h past room expiry
const REDIS_KEY_TTL_MIN_S = 60 * 60; // 1h
const REDIS_KEY_TTL_MAX_S = 48 * 60 * 60; // 2 days

const redisKeyTtlSeconds = (expiresAt?: Date | string): number => {
  const expiryMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiryMs)) return REDIS_KEY_TTL_MAX_S;

  const remainingS = Math.floor((expiryMs - Date.now()) / 1000) + REDIS_KEY_TTL_MARGIN_S;
  return Math.min(REDIS_KEY_TTL_MAX_S, Math.max(REDIS_KEY_TTL_MIN_S, remainingS));
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

/**
 * Atomically attempt to reserve `candidate` in the room's nickname set.
 * Returns true if it was free and is now reserved by the caller, false if
 * someone else already holds it. When Redis is unavailable, falls back to a
 * best-effort (non-atomic) check against live sockets + message history.
 */
const reserveNicknameInRoom = async (
  candidate: string,
  roomCode: string,
  excludeUserId: string,
  io: Server,
): Promise<boolean> => {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      const added = await redis.sadd(`room:${roomCode}:nicknames`, candidate.toLowerCase());
      if (added === 1) {
        // Successfully reserved — set TTL to 6 hours
        redis.expire(`room:${roomCode}:nicknames`, 21600).catch(() => {});
        return true;
      }
      // Already reserved by someone — but if it's this same user's own
      // existing nickname (a reconnect/refresh resending the nickname they
      // already hold), that's not a real conflict, just a redundant SADD.
      if (excludeUserId) {
        const currentNickname = await redis.hget(`user:${excludeUserId}`, 'nickname');
        if (currentNickname && currentNickname.toLowerCase() === candidate.toLowerCase()) {
          return true;
        }
      }
      return false; // Someone else already holds it
    } catch {
      // Redis unavailable — fall back to best-effort check below
    }
  }
  const existingNicknames = await buildExistingNicknamesFallback(roomCode, excludeUserId, io);
  return !existingNicknames.has(candidate.toLowerCase());
};

/**
 * Release a nickname reservation (e.g. a user changed their nickname, or
 * left the room) so it becomes available to others again.
 */
const releaseNicknameInRoom = async (roomCode: string, nickname: string): Promise<void> => {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.srem(`room:${roomCode}:nicknames`, nickname.toLowerCase());
    } catch (error: any) {
      logger.warn('Failed to release nickname reservation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

/**
 * Append a numeric suffix (no separator, so the result stays a single
 * alphanumeric token) until a free candidate is found, truncating the base
 * as needed to respect NICKNAME_MAX_LENGTH. Last-resort uniqueness fallback.
 */
const reserveWithNumericSuffix = async (
  baseNickname: string,
  roomCode: string,
  excludeUserId: string,
  io: Server,
): Promise<string> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.floor(Math.random() * 1000).toString();
    const truncatedBase = baseNickname.slice(0, Math.max(1, NICKNAME_MAX_LENGTH - suffix.length));
    const candidate = `${truncatedBase}${suffix}`;
    if (await reserveNicknameInRoom(candidate, roomCode, excludeUserId, io)) {
      return candidate;
    }
  }
  const timestampSuffix = Date.now().toString().slice(-4);
  return `${baseNickname.slice(0, Math.max(1, NICKNAME_MAX_LENGTH - timestampSuffix.length))}${timestampSuffix}`;
};

/**
 * Reserve a nickname the *system* generated (no exact spelling owed to the
 * user). On conflict, walks a shuffled pool of fresh candidate names instead
 * of mutating the original with a suffix — keeps every auto-generated
 * nickname a clean, unisex, one-word name. Only falls back to a numeric
 * suffix if the entire pool is exhausted (would require more concurrent
 * participants than distinct fallback names).
 */
const ensureGeneratedNicknameUniqueInRoom = async (
  baseNickname: string,
  roomCode: string,
  excludeUserId: string,
  io: Server,
): Promise<string> => {
  if (await reserveNicknameInRoom(baseNickname, roomCode, excludeUserId, io)) {
    return baseNickname;
  }

  for (const candidate of shuffleNicknamePool()) {
    if (candidate.toLowerCase() === baseNickname.toLowerCase()) continue;
    if (await reserveNicknameInRoom(candidate, roomCode, excludeUserId, io)) {
      logger.debug('Nickname conflict resolved with a fresh candidate name', {
        original: baseNickname, unique: candidate, roomCode, excludeUserId,
      });
      return candidate;
    }
  }

  logger.warn('Fallback name pool exhausted, using numeric suffix for uniqueness', {
    original: baseNickname, roomCode,
  });
  return reserveWithNumericSuffix(baseNickname, roomCode, excludeUserId, io);
};

/**
 * Reserve a user-supplied nickname at join time. Unlike the edit flow, a
 * taken nickname must never block the join — it falls back to a numeric
 * suffix so the requester still gets in, just not blocked on a name clash
 * with someone already in the room.
 */
const reserveCustomNicknameOrSuffix = async (
  candidate: string,
  roomCode: string,
  excludeUserId: string,
  io: Server,
): Promise<string> => {
  if (await reserveNicknameInRoom(candidate, roomCode, excludeUserId, io)) {
    return candidate;
  }
  return reserveWithNumericSuffix(candidate, roomCode, excludeUserId, io);
};

/**
 * Auto-generate a nickname for a user who didn't supply one (or whose
 * supplied nickname failed format validation).
 */
const autoGenerateNickname = async (roomCode: string, userId: string, io: Server): Promise<string> => {
  try {
    const baseNickname = await generateUniqueNicknameForRoom(roomCode);
    return await ensureGeneratedNicknameUniqueInRoom(baseNickname, roomCode, userId, io);
  } catch (error: any) {
    logger.warn('Failed to generate unique nickname, using Anonymous', {
      error: error instanceof Error ? error.message : String(error),
      roomCode,
    });
    return 'Anonymous';
  }
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
      } else {
        const providedNickname = data.nickname && typeof data.nickname === 'string' && data.nickname.trim()
          ? sanitizeName(data.nickname.trim())
          : '';

        if (providedNickname && isValidNicknameFormat(providedNickname)) {
          nickname = await reserveCustomNicknameOrSuffix(providedNickname, code, user.userId, io);
          if (nickname !== providedNickname) {
            logger.info('Provided nickname had conflict, appended suffix', {
              original: providedNickname, unique: nickname, roomCode: code, userId: user.userId,
            });
          }
        } else {
          if (providedNickname) {
            logger.info('Provided nickname failed format validation, auto-generating instead', {
              provided: providedNickname, roomCode: code, userId: user.userId,
            });
          }
          nickname = await autoGenerateNickname(code, user.userId, io);
          logger.debug('Generated unique nickname for room', { nickname, roomCode: code, userId: user.userId });
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
          // Safety net, not the primary reaper: purgeRoom deletes these keys
          // explicitly. Without a TTL, a purge that never ran (instance killed
          // mid-teardown, Redis unreachable at that moment) leaked both keys
          // forever — and a leaked `room:*:users` set inflates the participant
          // count of whatever room later inherits this recycled code. The
          // window is anchored to the room's own expiry so it always outlives
          // legitimate use.
          const ttlSeconds = redisKeyTtlSeconds(room.expiresAt);
          await redis.expire(`room:${code}:users`, ttlSeconds);
          await redis.expire(`user:${user.userId}`, ttlSeconds);
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
        // Sent only to this socket (never broadcast) — lets the ghost's own
        // client enable moderator-only UI (mute/kick/delete). Purely a UI
        // hint: every action it unlocks is re-authorized server-side via
        // canModerateRoom's isGhost check, so a forged/stale client value
        // here can't grant anything by itself.
        ...(user.isGhost ? { isGhost: true } : {}),
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

      const newName = sanitizeName(data.newName.trim());

      if (!isValidNicknameFormat(newName)) {
        socket.emit('error_alert', { message: NICKNAME_FORMAT_ERROR });
        return;
      }

      const oldNickname = user.nickname;

      if (newName.toLowerCase() === oldNickname.toLowerCase()) {
        socket.emit('error_alert', { message: 'That is already your nickname' });
        return;
      }

      // Unlike auto-generated nicknames, a name the user explicitly typed is
      // never silently substituted on conflict — reject with a clear error so
      // they can pick a different one, and leave their current nickname intact.
      const reserved = await reserveNicknameInRoom(newName, user.roomCode, user.userId, io);
      if (!reserved) {
        socket.emit('error_alert', { message: 'That nickname is already taken. Please choose a different one.' });
        return;
      }

      await releaseNicknameInRoom(user.roomCode, oldNickname);

      const uniqueNickname = newName;
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
