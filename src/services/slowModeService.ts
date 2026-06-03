const timestampsByUser = new Map<string, number[]>();

const key = (roomCode: string, userId: string): string => `${roomCode}:${userId}`;

/** Returns true if the user may send another message under slow mode. */
export const checkSlowMode = (
  roomCode: string,
  userId: string,
  messagesPerMinute: number,
): boolean => {
  if (!messagesPerMinute || messagesPerMinute <= 0) return true;

  const now = Date.now();
  const windowMs = 60_000;
  const k = key(roomCode, userId);
  let timestamps = timestampsByUser.get(k) || [];
  timestamps = timestamps.filter((t) => now - t < windowMs);

  if (timestamps.length >= messagesPerMinute) {
    timestampsByUser.set(k, timestamps);
    return false;
  }

  timestamps.push(now);
  timestampsByUser.set(k, timestamps);
  return true;
};

export const clearSlowModeForRoom = (roomCode: string): void => {
  for (const k of timestampsByUser.keys()) {
    if (k.startsWith(`${roomCode}:`)) {
      timestampsByUser.delete(k);
    }
  }
};
