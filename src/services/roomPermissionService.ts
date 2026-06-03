import { Room } from '../types/index.js';

export const isRoomOwner = (room: Room | null | undefined, userId: string): boolean =>
  !!(room?.ownerId && room.ownerId === userId);

export const isCoHost = (room: Room | null | undefined, userId: string): boolean =>
  !!(room?.coHostIds?.includes(userId));

/** Mute, kick, view participants, delete others' messages */
export const canModerateRoom = (room: Room | null | undefined, userId: string): boolean =>
  isRoomOwner(room, userId) || isCoHost(room, userId);

/** Transfer host, co-hosts, slow mode, end room */
export const canManageRoom = (room: Room | null | undefined, userId: string): boolean =>
  isRoomOwner(room, userId);
