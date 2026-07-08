import { getIoInstance } from '../socket/ioInstance.js';
import { SponsorBannerModel, IBannerFraming } from '../models/SponsorBanner.js';
import { RoomBannerAssignmentModel } from '../models/RoomBannerAssignment.js';

export interface RoomBannerPayload {
  title?: string;
  headerImageUrl: string;
  headerFraming: IBannerFraming;
  backgroundImageUrl: string;
  backgroundFraming: IBannerFraming;
  backgroundOpacity: number;
}

/** Resolve the banner a room currently displays (via its assignment), or null if none. */
export const resolveRoomBanner = async (roomCode: string): Promise<RoomBannerPayload | null> => {
  const assignment = await RoomBannerAssignmentModel.findOne({ roomCode }).select('bannerId').lean();
  if (!assignment) return null;

  const banner = await SponsorBannerModel.findById(assignment.bannerId)
    .select('headerImageUrl headerFraming backgroundImageUrl backgroundFraming backgroundOpacity title')
    .lean();
  if (!banner) return null;

  return {
    title: banner.title,
    headerImageUrl: banner.headerImageUrl,
    headerFraming: banner.headerFraming,
    backgroundImageUrl: banner.backgroundImageUrl,
    backgroundFraming: banner.backgroundFraming,
    backgroundOpacity: banner.backgroundOpacity,
  };
};

/** Push the current banner state to everyone connected to a room — no refresh required. */
export const broadcastRoomBannerUpdate = async (roomCode: string): Promise<void> => {
  const io = getIoInstance();
  if (!io) return;

  const banner = await resolveRoomBanner(roomCode);
  io.to(roomCode).emit('roomBannerUpdated', { banner });
};

/** Tell everyone connected to a room that its banner was removed. */
export const broadcastRoomBannerRemoved = async (roomCode: string): Promise<void> => {
  const io = getIoInstance();
  if (!io) return;

  io.to(roomCode).emit('roomBannerUpdated', { banner: null });
};
