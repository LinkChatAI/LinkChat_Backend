import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from './logger';

export const generateToken = (roomCode: string): string => {
  return jwt.sign({ roomCode }, env.JWT_SECRET, { expiresIn: '7d' });
};

export const verifyToken = (token: string): { roomCode: string } | null => {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'object' && decoded !== null && 'roomCode' in decoded) {
      return decoded as { roomCode: string };
    }
    return null;
  } catch (error) {
    logger.debug('Token verification failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return null;
  }
};

