/**
 * Per-room session moderation: mute and kick (in-memory, cleared when room ends).
 */

const mutedByRoom = new Map<string, Set<string>>();
const kickedByRoom = new Map<string, Set<string>>();

function roomSet(map: Map<string, Set<string>>, roomCode: string): Set<string> {
  if (!map.has(roomCode)) map.set(roomCode, new Set());
  return map.get(roomCode)!;
}

export function muteUser(roomCode: string, userId: string): void {
  roomSet(mutedByRoom, roomCode).add(userId);
}

export function unmuteUser(roomCode: string, userId: string): void {
  mutedByRoom.get(roomCode)?.delete(userId);
}

export function isUserMuted(roomCode: string, userId: string): boolean {
  return mutedByRoom.get(roomCode)?.has(userId) ?? false;
}

export function kickUser(roomCode: string, userId: string): void {
  roomSet(kickedByRoom, roomCode).add(userId);
  mutedByRoom.get(roomCode)?.delete(userId);
}

export function isUserKicked(roomCode: string, userId: string): boolean {
  return kickedByRoom.get(roomCode)?.has(userId) ?? false;
}

export function clearRoomModeration(roomCode: string): void {
  mutedByRoom.delete(roomCode);
  kickedByRoom.delete(roomCode);
}

export function getMutedUserIds(roomCode: string): string[] {
  return Array.from(mutedByRoom.get(roomCode) ?? []);
}
