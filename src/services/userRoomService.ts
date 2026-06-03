import { UserModel, SavedRoomEntry } from '../models/User.js';
import { RoomModel } from '../models/Room.js';
import { MessageModel } from '../models/Message.js';
import { isPremiumPlan } from '../utils/planUtils.js';
import { UserPlan } from '../types/index.js';
import { logger } from '../utils/logger.js';

const PREMIUM_HISTORY_DAYS = 7;
const PRO_HISTORY_DAYS = 30;
const RECOVERY_EXTENSION_HOURS = 24;

export interface SavedRoomSummary {
  roomCode: string;
  slug?: string;
  name?: string;
  savedAt: string;
  expiresAt?: string;
  isLocked?: boolean;
  isEnded?: boolean;
  participantCount?: number;
  plan?: string;
}

const getHistoryCutoff = (plan: UserPlan): Date => {
  const days = plan === 'pro' || plan === 'enterprise' ? PRO_HISTORY_DAYS : PREMIUM_HISTORY_DAYS;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
};

export const getSavedRooms = async (userId: string): Promise<SavedRoomSummary[]> => {
  const user = await UserModel.findById(userId).select('savedRooms plan').lean();
  if (!user || !isPremiumPlan(user.plan)) {
    return [];
  }

  const summaries: SavedRoomSummary[] = [];
  for (const saved of user.savedRooms) {
    const room = await RoomModel.findOne({ code: saved.roomCode }).lean();
    summaries.push({
      roomCode: saved.roomCode,
      slug: saved.slug || room?.slug,
      name: saved.name || room?.name,
      savedAt: saved.savedAt.toISOString(),
      expiresAt: room?.expiresAt?.toISOString(),
      isLocked: room?.isLocked,
      isEnded: room?.isEnded,
      participantCount: room?.participants?.length,
      plan: room?.plan,
    });
  }

  return summaries.sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
  );
};

export const saveRoomForUser = async (
  userId: string,
  roomCode: string
): Promise<SavedRoomEntry> => {
  const user = await UserModel.findById(userId);
  if (!user) throw new Error('User not found');
  if (!isPremiumPlan(user.plan)) {
    throw new Error('PREMIUM_REQUIRED');
  }

  const room = await RoomModel.findOne({ code: roomCode });
  if (!room) throw new Error('Room not found');

  const isOwner =
    room.ownerUserId === userId ||
    (user.linkedGuestId && room.ownerId === user.linkedGuestId);

  if (!isOwner) {
    throw new Error('Only room owners can save rooms');
  }

  const existing = user.savedRooms.find((s) => s.roomCode === roomCode);
  if (existing) return existing;

  const entry: SavedRoomEntry = {
    roomCode,
    slug: room.slug,
    name: room.name,
    savedAt: new Date(),
  };

  user.savedRooms.push(entry);
  await user.save();
  logger.info('Room saved for user', { userId, roomCode });
  return entry;
};

export const unsaveRoomForUser = async (userId: string, roomCode: string): Promise<void> => {
  await UserModel.updateOne(
    { _id: userId },
    { $pull: { savedRooms: { roomCode } } }
  );
};

export const getRoomHistoryForUser = async (
  userId: string,
  roomCode: string,
  limit = 100,
  before?: Date
) => {
  const user = await UserModel.findById(userId).select('plan linkedGuestId savedRooms').lean();
  if (!user) throw new Error('User not found');
  if (!isPremiumPlan(user.plan)) throw new Error('PREMIUM_REQUIRED');

  const room = await RoomModel.findOne({ code: roomCode }).lean();
  if (!room) throw new Error('Room not found');

  const isOwner =
    room.ownerUserId === userId ||
    (user.linkedGuestId && room.ownerId === user.linkedGuestId);
  const isSaved = user.savedRooms.some((s) => s.roomCode === roomCode);

  if (!isOwner && !isSaved) {
    throw new Error('Access denied to room history');
  }

  const cutoff = getHistoryCutoff(user.plan);
  const query: Record<string, unknown> = {
    roomCode,
    createdAt: { $gte: cutoff },
    deletedByAdmin: { $ne: true },
  };
  if (before) {
    query.createdAt = { ...(query.createdAt as object), $lt: before };
  }

  const messages = await MessageModel.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 500))
    .lean();

  return messages.reverse();
};

export const recoverRoomForUser = async (userId: string, roomCode: string) => {
  const user = await UserModel.findById(userId).select('plan linkedGuestId').lean();
  if (!user) throw new Error('User not found');
  if (!isPremiumPlan(user.plan)) throw new Error('PREMIUM_REQUIRED');

  const room = await RoomModel.findOne({ code: roomCode });
  if (!room) throw new Error('Room not found');

  const isOwner =
    room.ownerUserId === userId ||
    (user.linkedGuestId && room.ownerId === user.linkedGuestId);

  if (!isOwner) throw new Error('Only room owners can recover rooms');

  const now = new Date();
  const isExpired = room.expiresAt < now;
  const isLocked = room.isLocked;

  if (!isExpired && !isLocked && !room.isEnded) {
    return { room: room.toObject(), message: 'Room is already active' };
  }

  const extensionMs = RECOVERY_EXTENSION_HOURS * 60 * 60 * 1000;
  room.expiresAt = new Date(Date.now() + extensionMs);
  room.isLocked = false;
  room.lockedAt = undefined;
  room.isEnded = false;
  room.endedAt = undefined;
  room.endedBy = undefined;

  await room.save();

  await MessageModel.updateMany(
    { roomCode },
    { $set: { expiresAt: room.expiresAt } }
  );

  logger.info('Room recovered by premium user', { userId, roomCode });
  return { room: room.toObject(), message: 'Room recovered successfully' };
};

export const getOwnedRoomsForUser = async (userId: string) => {
  const user = await UserModel.findById(userId).select('plan linkedGuestId').lean();
  if (!user) throw new Error('User not found');
  if (!isPremiumPlan(user.plan)) throw new Error('PREMIUM_REQUIRED');

  const orConditions: Record<string, string>[] = [{ ownerUserId: userId }];
  if (user.linkedGuestId) {
    orConditions.push({ ownerId: user.linkedGuestId });
  }

  const cutoff = getHistoryCutoff(user.plan);
  const rooms = await RoomModel.find({
    $or: orConditions,
    createdAt: { $gte: cutoff },
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return rooms;
};

export const attachOwnerToRoom = async (
  roomCode: string,
  userId: string,
  guestId?: string
): Promise<void> => {
  const update: Record<string, string> = { ownerUserId: userId };
  if (guestId) {
    await UserModel.updateOne(
      { _id: userId, linkedGuestId: { $exists: false } },
      { linkedGuestId: guestId }
    );
  }
  await RoomModel.updateOne({ code: roomCode }, { $set: update });
};
