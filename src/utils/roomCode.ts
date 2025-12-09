import { RoomModel } from '../models/Room';
import { env } from '../config/env';

export const generateRoomCode = async (): Promise<string> => {
  let code: string;
  let exists = true;
  const maxAttempts = 100;
  let attempts = 0;

  while (exists && attempts < maxAttempts) {
    const min = Math.pow(10, env.ROOM_CODE_LENGTH - 1);
    const max = Math.pow(10, env.ROOM_CODE_LENGTH) - 1;
    code = Math.floor(min + Math.random() * (max - min + 1)).toString();
    const room = await RoomModel.findOne({ code });
    exists = !!room;
    attempts++;
  }

  if (attempts >= maxAttempts) {
    throw new Error('Failed to generate unique room code after maximum attempts');
  }

  return code!;
};

