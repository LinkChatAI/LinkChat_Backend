import { Server } from 'socket.io';
import { getRoomByCode } from '../services/roomService.js';
import { logger } from '../utils/logger.js';
import { SocketUser } from '../types/index.js';
import {
  clearScreenSharePresenter,
  getScreenSharePresenter,
  getScreenSharePublicState,
  hasPendingScreenShareRequest,
  removeScreenShareParticipant,
} from './screenShareState.js';

export type ScreenShareRoomGuardResult =
  | { ok: true; room: NonNullable<Awaited<ReturnType<typeof getRoomByCode>>> }
  | { ok: false; message: string };

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_SIGNALS = 60;

const signalRateBuckets = new Map<string, { count: number; windowStart: number }>();

type SocketLike = {
  data?: { user?: SocketUser };
  handshake?: { auth?: { userId?: unknown } };
};

export const getSocketUserId = (socket: SocketLike): string | undefined => {
  const fromData = socket.data?.user?.userId;
  const fromAuth = socket.handshake?.auth?.userId;
  const id =
    (typeof fromData === 'string' && fromData.trim()) ||
    (typeof fromAuth === 'string' && fromAuth.trim());
  return id || undefined;
};

export const emitToUserInRoom = async (
  io: Server,
  roomCode: string,
  targetUserId: string,
  event: string,
  payload: unknown
): Promise<boolean> => {
  try {
    const sockets = await io.in(roomCode).fetchSockets();
    const target = sockets.find((s) => getSocketUserId(s) === targetUserId);
    if (!target) return false;
    target.emit(event, payload);
    return true;
  } catch (error) {
    logger.warn('emitToUserInRoom failed', {
      roomCode,
      targetUserId,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

export const emitToRoomOwner = async (
  io: Server,
  roomCode: string,
  ownerId: string,
  event: string,
  payload: unknown
): Promise<void> => {
  await emitToUserInRoom(io, roomCode, ownerId, event, payload);
};

export const assertScreenShareAllowedInRoom = async (
  roomCode: string
): Promise<ScreenShareRoomGuardResult> => {
  if (!roomCode?.trim()) {
    return { ok: false, message: 'Invalid room' };
  }

  const room = await getRoomByCode(roomCode.trim());
  if (!room) {
    return { ok: false, message: 'Room not found' };
  }
  if (room.isEnded) {
    return { ok: false, message: 'This room has ended' };
  }
  if (room.isLocked) {
    return { ok: false, message: 'This room is locked' };
  }
  if (new Date() > room.expiresAt) {
    return { ok: false, message: 'Room expired' };
  }

  return { ok: true, room };
};

export const isRoomOwner = async (roomCode: string, userId: string): Promise<boolean> => {
  const room = await getRoomByCode(roomCode);
  return Boolean(room?.ownerId && room.ownerId === userId);
};

export const broadcastScreenShareState = (io: Server, roomCode: string): void => {
  io.to(roomCode).emit('screen_share:state', getScreenSharePublicState(roomCode));
};

export const broadcastScreenShareStopped = (
  io: Server,
  roomCode: string,
  stoppedBy: string,
  presenterId: string | null,
  reason?: string
): void => {
  io.to(roomCode).emit('screen_share:stopped', {
    presenterId,
    stoppedBy,
    reason,
  });
  broadcastScreenShareState(io, roomCode);
};

export const stopScreenSharePresentation = (
  io: Server,
  roomCode: string,
  stoppedBy: string,
  reason?: string
): string | null => {
  const presenterId = clearScreenSharePresenter(roomCode);
  broadcastScreenShareStopped(io, roomCode, stoppedBy, presenterId, reason);
  return presenterId;
};

/** Called when a participant leaves or disconnects. */
export const handleScreenShareParticipantLeft = (
  io: Server,
  roomCode: string,
  userId: string
): void => {
  if (!roomCode?.trim() || !userId?.trim()) return;

  const { wasPresenter, presenterId } = removeScreenShareParticipant(roomCode, userId);
  if (wasPresenter && presenterId) {
    broadcastScreenShareStopped(io, roomCode, userId, presenterId, 'Presenter left the room');
    logger.info('Screen share stopped because presenter left', { roomCode, userId });
  } else {
    broadcastScreenShareState(io, roomCode);
  }
};

export const validateScreenShareSignal = (
  signalType: string,
  payload: unknown
): boolean => {
  if (!SIGNAL_TYPES.has(signalType)) return false;
  if (!payload || typeof payload !== 'object') return false;

  const record = payload as Record<string, unknown>;

  if (signalType === 'ice') {
    return typeof record.candidate === 'string' || record.candidate === null || record.candidate === undefined;
  }

  return typeof record.type === 'string' && typeof record.sdp === 'string' && record.sdp.length <= 256_000;
};

export const checkScreenShareSignalRateLimit = (userId: string, roomCode: string): boolean => {
  const key = `${roomCode}:${userId}`;
  const now = Date.now();
  let bucket = signalRateBuckets.get(key);

  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    signalRateBuckets.set(key, bucket);
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_SIGNALS) {
    return false;
  }
  return true;
};

export const pruneScreenShareRateLimit = (): void => {
  const now = Date.now();
  for (const [key, bucket] of signalRateBuckets.entries()) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      signalRateBuckets.delete(key);
    }
  }
};

// Periodic cleanup (unref so it does not block process exit)
const rateLimitCleanupTimer = setInterval(pruneScreenShareRateLimit, 60_000);
if (typeof rateLimitCleanupTimer === 'object' && 'unref' in rateLimitCleanupTimer) {
  rateLimitCleanupTimer.unref();
}

export { hasPendingScreenShareRequest };
