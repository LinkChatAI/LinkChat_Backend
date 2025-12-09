import { RoomModel } from '../models/Room';
import { generateRoomCode } from '../utils/roomCode';
import { generateToken } from '../utils/jwt';
import { generateUniqueSlug, isNumericCode, extractCodeFromSlug } from '../utils/slug';
import { Room, CreateRoomRequest } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export const createRoom = async (data?: CreateRoomRequest): Promise<Room> => {
  const code = await generateRoomCode();
  const token = generateToken(code);
  const expiresAt = new Date(Date.now() + env.DEFAULT_ROOM_EXP_HOURS * 60 * 60 * 1000);

  let slug: string | undefined;
  if (data?.name) {
    slug = generateUniqueSlug(data.name, code);
    // Ensure slug uniqueness
    let existing = await RoomModel.findOne({ slug });
    let counter = 1;
    while (existing) {
      slug = generateUniqueSlug(data.name, `${code}-${counter}`);
      existing = await RoomModel.findOne({ slug });
      counter++;
    }
  }

  const room = new RoomModel({
    code,
    token,
    name: data?.name,
    slug,
    isPublic: data?.isPublic || false,
    expiresAt,
    participants: [],
  });

  await room.save();
  logger.debug('Room created', { code, slug, expiresAt: expiresAt.toISOString() });
  return room.toObject();
};

export const getRoomByCode = async (code: string): Promise<Room | null> => {
  const room = await RoomModel.findOne({ code });
  if (!room) return null;
  return room.toObject();
};

export const getRoomBySlug = async (slug: string): Promise<Room | null> => {
  const room = await RoomModel.findOne({ slug });
  if (!room) return null;
  return room.toObject();
};

export const getRoomBySlugOrCode = async (slugOrCode: string): Promise<Room | null> => {
  // Try as code first (numeric)
  if (isNumericCode(slugOrCode)) {
    const room = await getRoomByCode(slugOrCode);
    if (room) return room;
  }

  // Try as slug
  const room = await getRoomBySlug(slugOrCode);
  if (room) return room;

  // Try extracting code from slug format (e.g., "team-sync-8321")
  const extractedCode = extractCodeFromSlug(slugOrCode);
  if (extractedCode) {
    return getRoomByCode(extractedCode);
  }

  return null;
};

export const getPublicRooms = async (limit: number = 50): Promise<Room[]> => {
  const now = new Date();
  const maxLimit = Math.min(limit, 100); // Cap at 100 rooms
  const rooms = await RoomModel.find({
    isPublic: true,
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .limit(maxLimit)
    .select('code slug name createdAt expiresAt')
    .lean()
    .exec();
  return rooms;
};

export const verifyRoomToken = (token: string, code: string): boolean => {
  if (!token || !code || typeof token !== 'string' || typeof code !== 'string') {
    return false;
  }
  
  const { verifyToken } = require('../utils/jwt');
  const decoded = verifyToken(token);
  return decoded !== null && decoded.roomCode === code;
};

