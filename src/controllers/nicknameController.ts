import { Request, Response } from 'express';
import { generateUniqueNicknameForRoom } from '../utils/nickname.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

/**
 * GET /api/nickname?roomCode=1234
 * Generate a unique AI-powered nickname for a specific room
 * roomCode is optional - if not provided, generates a nickname without uniqueness check
 */
export const generateNicknameHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const roomCode = req.query.roomCode as string | undefined;
    
    // If roomCode is provided, ensure uniqueness within that room
    if (roomCode && typeof roomCode === 'string' && roomCode.trim()) {
      const nickname = await generateUniqueNicknameForRoom(roomCode.trim());
      res.json({
        nickname,
      });
      return;
    }
    
    // No roomCode provided - generate without uniqueness check (for backward compatibility)
    // This is used when user hasn't joined a room yet
    const { generateAiNickname } = await import('../utils/nickname.js');
    const nickname = await generateAiNickname();
    
    res.json({
      nickname,
    });
  } catch (error: any) {
    logger.error('Failed to generate nickname', {
      error: error instanceof Error ? error.message : String(error),
      roomCode: req.query.roomCode,
    });
    
    // Last resort: return a hardcoded fallback (warrior-like)
    res.json({
      nickname: 'Blade',
    });
  }
};
