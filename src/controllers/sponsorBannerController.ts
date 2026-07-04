import { Request, Response } from 'express';
import { SponsorBannerModel } from '../models/SponsorBanner.js';
import { RoomModel } from '../models/Room.js';
import { logger } from '../utils/logger.js';
import { broadcastRoomBannerUpdate } from '../services/roomBannerBroadcast.js';

const MAX_TITLE_LENGTH = 150;

/** GET /api/admin/sponsors/:roomCode — current banner for a room, or null if none set. */
export const getRoomBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const roomCode = String(req.params.roomCode || '').trim();
    if (!roomCode) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    const banner = await SponsorBannerModel.findOne({ roomCode }).lean();
    res.json({ banner: banner || null });
  } catch (error: unknown) {
    logger.error('Error fetching room banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch room banner' });
  }
};

/** PUT /api/admin/sponsors/:roomCode — create or replace the banner assigned to a room. */
export const upsertRoomBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const roomCode = String(req.params.roomCode || '').trim();
    if (!roomCode) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    const { title, imageUrl, storagePath } = req.body as {
      title?: string;
      imageUrl?: string;
      storagePath?: string;
    };

    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
      res.status(400).json({ error: 'Banner image is required' });
      return;
    }
    if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH)) {
      res.status(400).json({ error: `Title must be ${MAX_TITLE_LENGTH} characters or less` });
      return;
    }

    // Room must exist — the banner's lifetime is tied to it (see expiresAt mirroring below).
    const room = await RoomModel.findOne({ code: roomCode }).select('expiresAt').lean();
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const banner = await SponsorBannerModel.findOneAndUpdate(
      { roomCode },
      {
        roomCode,
        title: title?.trim() || undefined,
        imageUrl: imageUrl.trim(),
        storagePath: typeof storagePath === 'string' ? storagePath.trim() : undefined,
        expiresAt: room.expiresAt,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    void broadcastRoomBannerUpdate(roomCode);

    res.json({ banner });
  } catch (error: unknown) {
    logger.error('Error saving room banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to save room banner' });
  }
};

/** DELETE /api/admin/sponsors/:roomCode — remove the banner assigned to a room. */
export const deleteRoomBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const roomCode = String(req.params.roomCode || '').trim();
    if (!roomCode) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    const result = await SponsorBannerModel.findOneAndDelete({ roomCode });
    if (!result) {
      res.status(404).json({ error: 'No banner assigned to this room' });
      return;
    }

    void broadcastRoomBannerUpdate(roomCode);

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Error deleting room banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to delete room banner' });
  }
};
