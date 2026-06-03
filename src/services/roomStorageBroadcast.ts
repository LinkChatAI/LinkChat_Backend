import { getIoInstance } from '../socket/ioInstance.js';
import { RoomModel } from '../models/Room.js';
import { getStorageLimitForPlan } from '../constants/roomStorage.js';

export const broadcastRoomStorageUpdate = async (roomCode: string): Promise<void> => {
  const io = getIoInstance();
  if (!io) return;

  const room = await RoomModel.findOne({ code: roomCode }).select('storageUsed plan').lean();
  if (!room) return;

  io.to(roomCode).emit('roomStorageUpdated', {
    storageUsed: room.storageUsed || 0,
    storageLimitBytes: getStorageLimitForPlan(room.plan as string | undefined),
  });
};
