import { getIoInstance } from '../socket/ioInstance.js';
import { SponsorBannerModel } from '../models/SponsorBanner.js';

/** Push the current banner state to everyone connected to a room — no refresh required. */
export const broadcastRoomBannerUpdate = async (roomCode: string): Promise<void> => {
  const io = getIoInstance();
  if (!io) return;

  const banner = await SponsorBannerModel.findOne({ roomCode }).select('imageUrl title').lean();

  io.to(roomCode).emit('roomBannerUpdated', {
    banner: banner ? { imageUrl: banner.imageUrl, title: banner.title } : null,
  });
};
