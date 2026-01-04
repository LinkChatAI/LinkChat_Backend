import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { getRoomByCode } from './roomService.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_EXPIRY_SECONDS = 300; // 5 minutes

const generatePairingCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const generatePairingCodeForRoom = async (
  roomCode: string,
  userId: string
): Promise<string> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) {
    throw new Error('Redis not available for pairing');
  }

  // Verify room exists
  const room = await getRoomByCode(roomCode);
  if (!room) {
    throw new Error('Room not found');
  }

  if (new Date() > room.expiresAt) {
    throw new Error('Room expired');
  }

  // Generate unique pairing code
  let pairingCode = generatePairingCode();
  let attempts = 0;
  while (await redis.exists(`pairing:${pairingCode}`) && attempts < 10) {
    pairingCode = generatePairingCode();
    attempts++;
  }

  if (attempts >= 10) {
    throw new Error('Failed to generate unique pairing code');
  }

  // Store pairing code with room and user info
  const pairingData = {
    roomCode,
    userId,
    createdAt: Date.now(),
  };

  await redis.setex(
    `pairing:${pairingCode}`,
    PAIRING_CODE_EXPIRY_SECONDS,
    JSON.stringify(pairingData)
  );

  logger.debug('Pairing code generated', { pairingCode, roomCode });
  return pairingCode;
};

export const validatePairingCode = async (
  pairingCode: string
): Promise<{ roomCode: string; userId: string } | null> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) {
    throw new Error('Redis not available for pairing');
  }

  const data = await redis.get(`pairing:${pairingCode}`);
  if (!data) {
    return null;
  }

  const pairingData = JSON.parse(data);
  
  // Verify room still exists and is valid
  const room = await getRoomByCode(pairingData.roomCode);
  if (!room || new Date() > room.expiresAt) {
    await redis.del(`pairing:${pairingCode}`);
    return null;
  }

  // Delete pairing code after use (one-time use)
  await redis.del(`pairing:${pairingCode}`);

  return {
    roomCode: pairingData.roomCode,
    userId: pairingData.userId,
  };
};


