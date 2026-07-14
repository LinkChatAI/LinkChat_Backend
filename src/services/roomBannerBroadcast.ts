import { getIoInstance } from '../socket/ioInstance.js';
import { SponsorBannerModel, IBannerFraming } from '../models/SponsorBanner.js';
import { RoomBannerAssignmentModel } from '../models/RoomBannerAssignment.js';
import { DefaultBannerSettingModel } from '../models/DefaultBannerSetting.js';
import { RoomModel } from '../models/Room.js';
import { logger } from '../utils/logger.js';

export interface RoomBannerPayload {
  title?: string;
  headerImageUrl: string;
  headerFraming: IBannerFraming;
  backgroundImageUrl: string;
  backgroundFraming: IBannerFraming;
  backgroundOpacity: number;
}

const BANNER_SELECT = 'headerImageUrl headerFraming backgroundImageUrl backgroundFraming backgroundOpacity title';

const toPayload = (banner: {
  title?: string;
  headerImageUrl: string;
  headerFraming: IBannerFraming;
  backgroundImageUrl: string;
  backgroundFraming: IBannerFraming;
  backgroundOpacity: number;
}): RoomBannerPayload => ({
  title: banner.title,
  headerImageUrl: banner.headerImageUrl,
  headerFraming: banner.headerFraming,
  backgroundImageUrl: banner.backgroundImageUrl,
  backgroundFraming: banner.backgroundFraming,
  backgroundOpacity: banner.backgroundOpacity,
});

/** Resolve the platform-wide default banner (if one is set), or null. */
export const resolveDefaultBanner = async (): Promise<RoomBannerPayload | null> => {
  const setting = await DefaultBannerSettingModel.findById('global').select('bannerId').lean();
  if (!setting) return null;

  const banner = await SponsorBannerModel.findById(setting.bannerId).select(BANNER_SELECT).lean();
  if (!banner) return null;

  return toPayload(banner);
};

/** Resolve the banner a room currently displays: its own assignment always wins; if a room has
 *  no assignment at all, the platform default banner (if any) is used as a fallback. */
export const resolveRoomBanner = async (roomCode: string): Promise<RoomBannerPayload | null> => {
  const assignment = await RoomBannerAssignmentModel.findOne({ roomCode }).select('bannerId').lean();
  if (assignment) {
    const banner = await SponsorBannerModel.findById(assignment.bannerId).select(BANNER_SELECT).lean();
    return banner ? toPayload(banner) : null;
  }

  return resolveDefaultBanner();
};

/** Push the current banner state to everyone connected to a room — no refresh required. Also
 *  used to correctly reflect an unassignment: the room re-resolves and falls back to the
 *  default banner if one is set, instead of always going blank. */
export const broadcastRoomBannerUpdate = async (roomCode: string): Promise<void> => {
  const io = getIoInstance();
  if (!io) return;

  const banner = await resolveRoomBanner(roomCode);
  io.to(roomCode).emit('roomBannerUpdated', { banner });
};

/** Push the platform default banner (or its removal) to every currently active room that has no
 *  room-specific assignment — rooms with their own banner are untouched. Only rooms with
 *  connected sockets actually receive anything (io.to() on an empty room is a no-op); any other
 *  room picks up the new default lazily via resolveRoomBanner() the next time someone joins. */
export const broadcastDefaultBannerUpdate = async (): Promise<void> => {
  const io = getIoInstance();
  if (!io) return;

  try {
    const now = new Date();
    const activeRooms = await RoomModel.find({ isEnded: { $ne: true }, expiresAt: { $gt: now } })
      .select('code')
      .lean();
    if (activeRooms.length === 0) return;

    const activeCodes = activeRooms.map((r) => r.code);
    const assigned = await RoomBannerAssignmentModel.find({ roomCode: { $in: activeCodes } })
      .select('roomCode')
      .lean();
    const assignedCodes = new Set(assigned.map((a) => a.roomCode));

    const targets = activeCodes.filter((code) => !assignedCodes.has(code));
    if (targets.length === 0) return;

    // Resolved once and reused for every target — these rooms are all falling back to the
    // same default, so there's no need to re-run resolveRoomBanner (and its assignment lookup)
    // per room.
    const banner = await resolveDefaultBanner();
    for (const code of targets) {
      io.to(code).emit('roomBannerUpdated', { banner });
    }
    logger.info(`Broadcast default banner update to ${targets.length} active room(s)`);
  } catch (error: unknown) {
    logger.error('Failed to broadcast default banner update', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
