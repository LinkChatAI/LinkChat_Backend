import { Room } from '../types/index.js';

export const isRoomOwner = (room: Room | null | undefined, userId: string): boolean =>
  !!(room?.ownerId && room.ownerId === userId);

export const isCoHost = (room: Room | null | undefined, userId: string): boolean =>
  !!(room?.coHostIds?.includes(userId));

/**
 * Mute, kick, view participants, delete others' messages.
 *
 * `isGhost` grants Super Admin Ghost Mode the same moderation authority as a
 * co-host (see utils/ghostMode.ts) WITHOUT making it an actual co-host —
 * room.coHostIds is never touched, so the grant never appears in
 * roomSettingsUpdated broadcasts, the participants list, or any other
 * room-facing state. Only server-verified `SocketUser.isGhost` may be passed
 * here; it is never sourced from client input.
 */
export const canModerateRoom = (
  room: Room | null | undefined,
  userId: string,
  isGhost?: boolean
): boolean => isGhost === true || isRoomOwner(room, userId) || isCoHost(room, userId);

/** Transfer host, co-hosts, slow mode, end room */
export const canManageRoom = (room: Room | null | undefined, userId: string): boolean =>
  isRoomOwner(room, userId);
