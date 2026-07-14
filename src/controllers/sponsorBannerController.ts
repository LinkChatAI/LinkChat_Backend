import { Request, Response } from 'express';
import { SponsorBannerModel, DEFAULT_BANNER_BACKGROUND_OPACITY, IBannerFraming } from '../models/SponsorBanner.js';
import { RoomBannerAssignmentModel } from '../models/RoomBannerAssignment.js';
import { DefaultBannerSettingModel } from '../models/DefaultBannerSetting.js';
import { RoomModel } from '../models/Room.js';
import { logger } from '../utils/logger.js';
import { broadcastRoomBannerUpdate, broadcastDefaultBannerUpdate } from '../services/roomBannerBroadcast.js';

const MAX_TITLE_LENGTH = 150;

const isValidFraming = (value: unknown): value is IBannerFraming => {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.x === 'number' && f.x >= 0 && f.x <= 100 &&
    typeof f.y === 'number' && f.y >= 0 && f.y <= 100 &&
    typeof f.zoom === 'number' && f.zoom >= 1 && f.zoom <= 3 &&
    (f.fit === undefined || f.fit === 'cover' || f.fit === 'contain')
  );
};

interface BannerBody {
  title?: string;
  headerImageUrl?: string;
  headerStoragePath?: string;
  headerFraming?: unknown;
  backgroundImageUrl?: string;
  backgroundStoragePath?: string;
  backgroundFraming?: unknown;
  backgroundOpacity?: number;
  roomCodes?: unknown;
}

const validateBannerBody = (body: BannerBody, requireImages: boolean): string | null => {
  if (requireImages && (!body.headerImageUrl || typeof body.headerImageUrl !== 'string' || !body.headerImageUrl.trim())) {
    return 'Header banner image is required';
  }
  if (requireImages && (!body.backgroundImageUrl || typeof body.backgroundImageUrl !== 'string' || !body.backgroundImageUrl.trim())) {
    return 'Chat background image is required';
  }
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > MAX_TITLE_LENGTH)) {
    return `Title must be ${MAX_TITLE_LENGTH} characters or less`;
  }
  if (body.headerFraming !== undefined && !isValidFraming(body.headerFraming)) {
    return 'Invalid header framing';
  }
  if (body.backgroundFraming !== undefined && !isValidFraming(body.backgroundFraming)) {
    return 'Invalid background framing';
  }
  if (
    body.backgroundOpacity !== undefined &&
    (typeof body.backgroundOpacity !== 'number' || Number.isNaN(body.backgroundOpacity) || body.backgroundOpacity < 0 || body.backgroundOpacity > 1)
  ) {
    return 'Background opacity must be a number between 0 and 1';
  }
  if (body.roomCodes !== undefined && (!Array.isArray(body.roomCodes) || body.roomCodes.some((c) => typeof c !== 'string'))) {
    return 'roomCodes must be an array of room code strings';
  }
  return null;
};

/** Fetch { [bannerId]: roomCode[] } for a set of banner ids (or all, if ids is undefined). */
const getAssignedRoomCodesByBanner = async (bannerIds?: string[]): Promise<Map<string, string[]>> => {
  const filter = bannerIds ? { bannerId: { $in: bannerIds } } : {};
  const assignments = await RoomBannerAssignmentModel.find(filter).select('roomCode bannerId').lean();
  const map = new Map<string, string[]>();
  for (const a of assignments) {
    const key = String(a.bannerId);
    const list = map.get(key) || [];
    list.push(a.roomCode);
    map.set(key, list);
  }
  return map;
};

/** Replace the set of rooms assigned to a banner with `roomCodes`, validating each room exists.
 *  Rooms already assigned to a DIFFERENT banner get reassigned (a room can only show one banner). */
const applyRoomAssignments = async (
  bannerId: string,
  roomCodes: string[]
): Promise<{ ok: true; addedOrKept: string[]; removed: string[] } | { ok: false; error: string }> => {
  const trimmed = [...new Set(roomCodes.map((c) => c.trim()).filter(Boolean))];

  for (const code of trimmed) {
    const room = await RoomModel.findOne({ code }).select('expiresAt').lean();
    if (!room) {
      return { ok: false, error: `Room ${code} not found` };
    }
    await RoomBannerAssignmentModel.findOneAndUpdate(
      { roomCode: code },
      { roomCode: code, bannerId, expiresAt: room.expiresAt },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  const existing = await RoomBannerAssignmentModel.find({ bannerId }).select('roomCode').lean();
  const removed = existing.map((e) => e.roomCode).filter((code) => !trimmed.includes(code));
  if (removed.length > 0) {
    await RoomBannerAssignmentModel.deleteMany({ bannerId, roomCode: { $in: removed } });
  }

  return { ok: true, addedOrKept: trimmed, removed };
};

/** GET /api/admin/banners — list every banner asset with the rooms it's assigned to. */
export const listBanners = async (_req: Request, res: Response): Promise<void> => {
  try {
    const banners = await SponsorBannerModel.find({}).sort({ updatedAt: -1 }).lean();
    const [roomsByBanner, defaultSetting] = await Promise.all([
      getAssignedRoomCodesByBanner(),
      DefaultBannerSettingModel.findById('global').select('bannerId').lean(),
    ]);
    const defaultBannerId = defaultSetting ? String(defaultSetting.bannerId) : null;

    res.json({
      banners: banners.map((b) => ({
        ...b,
        assignedRoomCodes: roomsByBanner.get(String(b._id)) || [],
        isDefault: defaultBannerId === String(b._id),
      })),
      defaultBannerId,
    });
  } catch (error: unknown) {
    logger.error('Error listing sponsor banners', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list sponsor banners' });
  }
};

/** POST /api/admin/banners — create a new reusable banner asset, optionally assigning it to rooms. */
export const createBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as BannerBody;
    const validationError = validateBannerBody(body, true);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const banner = await SponsorBannerModel.create({
      title: body.title?.trim() || undefined,
      headerImageUrl: body.headerImageUrl!.trim(),
      headerStoragePath: typeof body.headerStoragePath === 'string' ? body.headerStoragePath.trim() : undefined,
      headerFraming: body.headerFraming as IBannerFraming | undefined,
      backgroundImageUrl: body.backgroundImageUrl!.trim(),
      backgroundStoragePath: typeof body.backgroundStoragePath === 'string' ? body.backgroundStoragePath.trim() : undefined,
      backgroundFraming: body.backgroundFraming as IBannerFraming | undefined,
      backgroundOpacity: body.backgroundOpacity ?? DEFAULT_BANNER_BACKGROUND_OPACITY,
    });

    let assignedRoomCodes: string[] = [];
    if (Array.isArray(body.roomCodes) && body.roomCodes.length > 0) {
      const result = await applyRoomAssignments(String(banner._id), body.roomCodes as string[]);
      if (!result.ok) {
        // Banner asset is still created — just report the assignment problem.
        res.status(201).json({ banner: { ...banner.toObject(), assignedRoomCodes: [] }, assignmentError: result.error });
        return;
      }
      assignedRoomCodes = result.addedOrKept;
      await Promise.all(assignedRoomCodes.map((code) => broadcastRoomBannerUpdate(code)));
    }

    res.status(201).json({ banner: { ...banner.toObject(), assignedRoomCodes } });
  } catch (error: unknown) {
    logger.error('Error creating sponsor banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to create sponsor banner' });
  }
};

/** PUT /api/admin/banners/:id — update a banner asset's images/framing/opacity and/or room assignments.
 *  The header and background images can be replaced independently of each other. */
export const updateBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const body = req.body as BannerBody;
    const validationError = validateBannerBody(body, false);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const update: Record<string, unknown> = {};
    if (body.title !== undefined) update.title = body.title.trim() || undefined;
    if (body.headerImageUrl !== undefined) update.headerImageUrl = body.headerImageUrl.trim();
    if (body.headerStoragePath !== undefined) update.headerStoragePath = body.headerStoragePath;
    if (body.headerFraming !== undefined) update.headerFraming = body.headerFraming;
    if (body.backgroundImageUrl !== undefined) update.backgroundImageUrl = body.backgroundImageUrl.trim();
    if (body.backgroundStoragePath !== undefined) update.backgroundStoragePath = body.backgroundStoragePath;
    if (body.backgroundFraming !== undefined) update.backgroundFraming = body.backgroundFraming;
    if (body.backgroundOpacity !== undefined) update.backgroundOpacity = body.backgroundOpacity;

    const banner = await SponsorBannerModel.findByIdAndUpdate(id, update, { new: true });
    if (!banner) {
      res.status(404).json({ error: 'Banner not found' });
      return;
    }

    let assignedRoomCodes = (await getAssignedRoomCodesByBanner([id])).get(id) || [];
    let removedRoomCodes: string[] = [];

    if (Array.isArray(body.roomCodes)) {
      const result = await applyRoomAssignments(id, body.roomCodes as string[]);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      assignedRoomCodes = result.addedOrKept;
      removedRoomCodes = result.removed;
    }

    await Promise.all([
      ...assignedRoomCodes.map((code) => broadcastRoomBannerUpdate(code)),
      // A room that lost this assignment re-resolves and falls back to the default banner
      // (if any) instead of always going blank — same broadcast helper handles both cases.
      ...removedRoomCodes.map((code) => broadcastRoomBannerUpdate(code)),
    ]);

    res.json({ banner: { ...banner.toObject(), assignedRoomCodes } });
  } catch (error: unknown) {
    logger.error('Error updating sponsor banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to update sponsor banner' });
  }
};

/** DELETE /api/admin/banners/:id — delete a banner asset and unassign it from every room. */
export const deleteBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const banner = await SponsorBannerModel.findByIdAndDelete(id);
    if (!banner) {
      res.status(404).json({ error: 'Banner not found' });
      return;
    }

    const assignments = await RoomBannerAssignmentModel.find({ bannerId: id }).select('roomCode').lean();
    await RoomBannerAssignmentModel.deleteMany({ bannerId: id });
    // Each affected room re-resolves — falls back to the default banner (if any) rather than
    // always going blank.
    await Promise.all(assignments.map((a) => broadcastRoomBannerUpdate(a.roomCode)));

    const defaultSetting = await DefaultBannerSettingModel.findById('global').select('bannerId').lean();
    if (defaultSetting && String(defaultSetting.bannerId) === id) {
      await DefaultBannerSettingModel.findByIdAndDelete('global');
      void broadcastDefaultBannerUpdate();
    }

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Error deleting sponsor banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to delete sponsor banner' });
  }
};

/** GET /api/admin/room-banners — every room-banner mapping, for the single "manage all" view. */
export const listRoomBannerMappings = async (_req: Request, res: Response): Promise<void> => {
  try {
    const assignments = await RoomBannerAssignmentModel.find({}).sort({ updatedAt: -1 }).lean();
    if (assignments.length === 0) {
      res.json({ mappings: [] });
      return;
    }

    const bannerIds = [...new Set(assignments.map((a) => String(a.bannerId)))];
    const roomCodes = assignments.map((a) => a.roomCode);

    const [banners, rooms] = await Promise.all([
      SponsorBannerModel.find({ _id: { $in: bannerIds } }).select('title headerImageUrl').lean(),
      RoomModel.find({ code: { $in: roomCodes } }).select('code name isLocked isEnded').lean(),
    ]);
    const bannerById = new Map(banners.map((b) => [String(b._id), b]));
    const roomByCode = new Map(rooms.map((r) => [r.code, r]));

    const mappings = assignments.map((a) => {
      const banner = bannerById.get(String(a.bannerId));
      const room = roomByCode.get(a.roomCode);
      return {
        roomCode: a.roomCode,
        roomName: room?.name || a.roomCode,
        roomStatus: room ? (room.isEnded ? 'ended' : room.isLocked ? 'locked' : 'active') : 'unknown',
        bannerId: String(a.bannerId),
        bannerTitle: banner?.title,
        bannerImageUrl: banner?.headerImageUrl,
        updatedAt: a.updatedAt,
      };
    });

    res.json({ mappings });
  } catch (error: unknown) {
    logger.error('Error listing room banner mappings', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list room banner mappings' });
  }
};

/** PUT /api/admin/room-banners/:roomCode — assign (or change) the banner a room displays. */
export const assignRoomBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const roomCode = String(req.params.roomCode || '').trim();
    const { bannerId } = req.body as { bannerId?: string };
    if (!roomCode) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }
    if (!bannerId || typeof bannerId !== 'string') {
      res.status(400).json({ error: 'bannerId is required' });
      return;
    }

    const [room, banner] = await Promise.all([
      RoomModel.findOne({ code: roomCode }).select('expiresAt').lean(),
      SponsorBannerModel.findById(bannerId).select('_id').lean(),
    ]);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    if (!banner) {
      res.status(404).json({ error: 'Banner not found' });
      return;
    }

    const assignment = await RoomBannerAssignmentModel.findOneAndUpdate(
      { roomCode },
      { roomCode, bannerId, expiresAt: room.expiresAt },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    void broadcastRoomBannerUpdate(roomCode);

    res.json({ mapping: assignment });
  } catch (error: unknown) {
    logger.error('Error assigning room banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to assign banner to room' });
  }
};

/** DELETE /api/admin/room-banners/:roomCode — unassign whatever banner a room currently shows. */
export const unassignRoomBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const roomCode = String(req.params.roomCode || '').trim();
    if (!roomCode) {
      res.status(400).json({ error: 'Room code is required' });
      return;
    }

    const result = await RoomBannerAssignmentModel.findOneAndDelete({ roomCode });
    if (!result) {
      res.status(404).json({ error: 'No banner assigned to this room' });
      return;
    }

    // Falls back to the default banner (if any) instead of always going blank.
    void broadcastRoomBannerUpdate(roomCode);

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Error unassigning room banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to unassign banner from room' });
  }
};

/** PUT /api/admin/default-banner — set the platform-wide default banner, shown in every room
 *  that has no room-specific assignment (existing rooms and any created afterward). Never
 *  touches rooms that already have their own banner assigned. */
export const setDefaultBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bannerId } = req.body as { bannerId?: string };
    if (!bannerId || typeof bannerId !== 'string') {
      res.status(400).json({ error: 'bannerId is required' });
      return;
    }

    const banner = await SponsorBannerModel.findById(bannerId).select('_id').lean();
    if (!banner) {
      res.status(404).json({ error: 'Banner not found' });
      return;
    }

    await DefaultBannerSettingModel.findByIdAndUpdate(
      'global',
      { _id: 'global', bannerId },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    void broadcastDefaultBannerUpdate();

    res.json({ success: true, defaultBannerId: bannerId });
  } catch (error: unknown) {
    logger.error('Error setting default banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to set default banner' });
  }
};

/** DELETE /api/admin/default-banner — clear the platform default. Rooms with their own
 *  assignment are unaffected; rooms that were only showing the default go blank. */
export const clearDefaultBanner = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await DefaultBannerSettingModel.findByIdAndDelete('global');
    if (!result) {
      res.status(404).json({ error: 'No default banner is set' });
      return;
    }

    void broadcastDefaultBannerUpdate();

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Error clearing default banner', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to clear default banner' });
  }
};
