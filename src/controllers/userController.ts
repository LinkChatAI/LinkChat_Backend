import { Response } from 'express';
import { UserAuthRequest } from '../middleware/userAuth.js';
import {
  getSavedRooms,
  saveRoomForUser,
  unsaveRoomForUser,
  getRoomHistoryForUser,
  recoverRoomForUser,
  getOwnedRoomsForUser,
} from '../services/userRoomService.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

export const listSavedRoomsHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const rooms = await getSavedRooms(req.user!.userId);
    res.json({ rooms });
  } catch (error) {
    logger.error('Failed to list saved rooms', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list saved rooms' });
  }
};

export const saveRoomHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    const entry = await saveRoomForUser(req.user!.userId, code);
    res.json({ success: true, savedRoom: entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save room';
    if (message === 'PREMIUM_REQUIRED') {
      res.status(403).json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' });
      return;
    }
    if (message === 'Room not found') {
      res.status(404).json({ error: message });
      return;
    }
    if (message === 'Only room owners can save rooms') {
      res.status(403).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
};

export const unsaveRoomHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    await unsaveRoomForUser(req.user!.userId, code);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unsave room' });
  }
};

const historyQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).optional(),
  before: z.string().datetime().optional(),
});

export const roomHistoryHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    const query = historyQuerySchema.parse(req.query);
    const before = query.before ? new Date(query.before) : undefined;

    const messages = await getRoomHistoryForUser(
      req.user!.userId,
      code,
      query.limit,
      before
    );

    res.json({ messages, roomCode: code });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get history';
    if (message === 'PREMIUM_REQUIRED') {
      res.status(403).json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' });
      return;
    }
    if (message === 'Room not found') {
      res.status(404).json({ error: message });
      return;
    }
    if (message === 'Access denied to room history') {
      res.status(403).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
};

export const recoverRoomHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    const result = await recoverRoomForUser(req.user!.userId, code);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to recover room';
    if (message === 'PREMIUM_REQUIRED') {
      res.status(403).json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' });
      return;
    }
    if (message === 'Room not found') {
      res.status(404).json({ error: message });
      return;
    }
    if (message === 'Only room owners can recover rooms') {
      res.status(403).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
};

export const listOwnedRoomsHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const rooms = await getOwnedRoomsForUser(req.user!.userId);
    res.json({
      rooms: rooms.map((r) => ({
        code: r.code,
        slug: r.slug,
        name: r.name,
        plan: r.plan,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        isLocked: r.isLocked,
        isEnded: r.isEnded,
        participantCount: r.participants?.length ?? 0,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list rooms';
    if (message === 'PREMIUM_REQUIRED') {
      res.status(403).json({ error: 'Premium subscription required', code: 'PREMIUM_REQUIRED' });
      return;
    }
    res.status(500).json({ error: message });
  }
};
