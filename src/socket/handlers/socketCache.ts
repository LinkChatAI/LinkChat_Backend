import { Server } from 'socket.io';

/**
 * `io.in(roomCode).fetchSockets()` is a cross-instance call (goes through the
 * Redis adapter's request/response pub/sub when running multiple Cloud Run
 * instances). It's called on every join and every participants-panel refresh,
 * so a burst of joins/leaves in a large room can fire it dozens of times
 * within the same second. Memoize the result per room for a short window so
 * those bursts collapse into a single cross-instance round trip.
 */
const CACHE_TTL_MS = 1000;

type CacheEntry = {
  expiresAt: number;
  promise: Promise<Awaited<ReturnType<Server['fetchSockets']>>>;
};

const cache = new Map<string, CacheEntry>();

export const getCachedRoomSockets = (
  io: Server,
  roomCode: string,
): Promise<Awaited<ReturnType<Server['fetchSockets']>>> => {
  const now = Date.now();
  const existing = cache.get(roomCode);
  if (existing && existing.expiresAt > now) {
    return existing.promise;
  }

  const promise = io.in(roomCode).fetchSockets();
  cache.set(roomCode, { expiresAt: now + CACHE_TTL_MS, promise });

  // Don't let a rejected fetch poison the cache for the rest of the TTL window.
  promise.catch(() => cache.delete(roomCode));

  return promise;
};
