import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const ROOM_CODE_PATTERNS = ['xxxx', 'xyyy', 'xxyy', 'xxxy', 'xyxy'] as const;

const buildAllPatternedRoomCodes = (): readonly string[] => {
  const codes = new Set<string>();
  for (let x = 0; x < 10; x++) {
    for (let y = 0; y < 10; y++) {
      codes.add(`${x}${x}${x}${x}`);
      codes.add(`${x}${y}${y}${y}`);
      codes.add(`${x}${x}${y}${y}`);
      codes.add(`${x}${x}${x}${y}`);
      codes.add(`${x}${y}${x}${y}`);
    }
  }
  return [...codes];
};

export const ALL_PATTERNED_ROOM_CODES = buildAllPatternedRoomCodes();

const randomDigit = (): number => Math.floor(Math.random() * 10);

const pickRandom = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)];

/** Returns true if a 4-digit code matches xxxx, xyyy, xxyy, xxxy, or xyxy (x,y ∈ 0-9). */
export const matchesRoomCodePattern = (code: string): boolean => {
  if (code.length !== 4 || !/^\d{4}$/.test(code)) {
    return false;
  }

  const [a, b, c, d] = code.split('');

  return (
    (a === b && b === c && c === d) || // xxxx
    (b === c && c === d) || // xyyy
    (a === b && c === d) || // xxyy
    (a === b && b === c) || // xxxy
    (a === c && b === d) // xyxy
  );
};

export const generatePatternedRoomCode = (): string => {
  const pattern = ROOM_CODE_PATTERNS[Math.floor(Math.random() * ROOM_CODE_PATTERNS.length)];
  const x = randomDigit();
  const y = randomDigit();

  switch (pattern) {
    case 'xxxx':
      return `${x}${x}${x}${x}`;
    case 'xyyy':
      return `${x}${y}${y}${y}`;
    case 'xxyy':
      return `${x}${x}${y}${y}`;
    case 'xxxy':
      return `${x}${x}${x}${y}`;
    case 'xyxy':
      return `${x}${y}${x}${y}`;
    default: {
      const _exhaustive: never = pattern;
      return _exhaustive;
    }
  }
};

const generateRandomRoomCode = (): string => {
  const min = Math.pow(10, env.ROOM_CODE_LENGTH - 1);
  const max = Math.pow(10, env.ROOM_CODE_LENGTH) - 1;
  return Math.floor(min + Math.random() * (max - min + 1)).toString();
};

const generateUniquePatternedRoomCode = async (): Promise<string> => {
  const maxAttempts = 30;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = pickRandom(ALL_PATTERNED_ROOM_CODES);
    const room = await RoomModel.findOne({ code }).select('_id').lean();
    if (!room) {
      return code;
    }
  }

  const takenRooms = await RoomModel.find({ code: { $in: [...ALL_PATTERNED_ROOM_CODES] } })
    .select('code')
    .lean();
  const takenCodes = new Set(takenRooms.map((room) => room.code));
  const availableCodes = ALL_PATTERNED_ROOM_CODES.filter((code) => !takenCodes.has(code));

  if (availableCodes.length === 0) {
    throw new Error('No patterned room codes available');
  }

  return pickRandom(availableCodes);
};

const generateUniqueRoomCode = async (): Promise<string> => {
  if (env.ROOM_CODE_LENGTH === 4) {
    return generateUniquePatternedRoomCode();
  }

  const maxAttempts = 100;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateRandomRoomCode();
    const room = await RoomModel.findOne({ code }).select('_id').lean();
    if (!room) {
      return code;
    }
  }

  throw new Error('Failed to generate unique room code after maximum attempts');
};

export const generateRoomCode = async (): Promise<string> => {
  if (mongoose.connection.readyState !== 1) {
    logger.error('Database not connected when generating room code');
    throw new Error('Database connection not available');
  }

  try {
    const code = await generateUniqueRoomCode();

    if (env.ROOM_CODE_LENGTH === 4 && !matchesRoomCodePattern(code)) {
      logger.error('Generated room code does not match required pattern', { code });
      throw new Error('Failed to generate valid patterned room code');
    }

    return code;
  } catch (error: any) {
    if (error.name === 'MongoServerSelectionError' || error.name === 'MongoNetworkError') {
      logger.error('MongoDB connection error when generating room code', {
        error: error.message,
      });
      throw new Error('Database connection not available');
    }

    logger.error('Error generating room code', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error.name,
      errorCode: error.code,
    });
    throw error;
  }
};
