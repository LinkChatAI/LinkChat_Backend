import { logger } from '../../utils/logger.js';

/**
 * Pending per-room / per-user timers, extracted from roomLifecycleHandlers so
 * the purge path can cancel them without importing that module (which itself
 * imports the purge service — extracting these breaks the cycle).
 *
 * Both registries hold live `setTimeout` handles measured in tens of minutes.
 * Cancelling them on purge is not just hygiene: a timer that survives its room
 * fires against a code that has already been recycled, so it would operate on
 * whatever room now holds that code.
 */

// Host-left grace period: destroys the room if the host doesn't return.
const pendingDeletionTimers = new Map<string, NodeJS.Timeout>();

// Participant disconnect grace period, keyed `${roomCode}:${userId}`.
const pendingUserLeaveTimers = new Map<string, NodeJS.Timeout>();

export const userLeaveTimerKey = (roomCode: string, userId: string): string =>
  `${roomCode}:${userId}`;

export const hasPendingDeletion = (roomCode: string): boolean =>
  pendingDeletionTimers.has(roomCode);

export const setPendingDeletionTimer = (roomCode: string, timer: NodeJS.Timeout): void => {
  pendingDeletionTimers.set(roomCode, timer);
};

export const forgetPendingDeletionTimer = (roomCode: string): void => {
  pendingDeletionTimers.delete(roomCode);
};

export const clearPendingDeletionTimer = (roomCode: string): void => {
  const timer = pendingDeletionTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    pendingDeletionTimers.delete(roomCode);
    logger.info(`Cleared pending deletion timer for room ${roomCode}`);
  }
};

export const hasPendingUserLeaveTimer = (roomCode: string, userId: string): boolean =>
  pendingUserLeaveTimers.has(userLeaveTimerKey(roomCode, userId));

export const setPendingUserLeaveTimer = (
  roomCode: string,
  userId: string,
  timer: NodeJS.Timeout,
): void => {
  pendingUserLeaveTimers.set(userLeaveTimerKey(roomCode, userId), timer);
};

export const forgetPendingUserLeaveTimer = (roomCode: string, userId: string): void => {
  pendingUserLeaveTimers.delete(userLeaveTimerKey(roomCode, userId));
};

export const clearPendingUserLeaveTimer = (roomCode: string, userId: string): void => {
  const key = userLeaveTimerKey(roomCode, userId);
  const timer = pendingUserLeaveTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingUserLeaveTimers.delete(key);
    logger.info(`Cleared pending leave timer for user ${userId} in room ${roomCode}`);
  }
};

/**
 * Cancel every outstanding timer for a room. Called from the purge path, which
 * is the only place that knows the room is gone for good.
 */
export const clearAllTimersForRoom = (roomCode: string): number => {
  let cleared = 0;

  const deletionTimer = pendingDeletionTimers.get(roomCode);
  if (deletionTimer) {
    clearTimeout(deletionTimer);
    pendingDeletionTimers.delete(roomCode);
    cleared++;
  }

  const prefix = `${roomCode}:`;
  for (const [key, timer] of pendingUserLeaveTimers) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      pendingUserLeaveTimers.delete(key);
      cleared++;
    }
  }

  return cleared;
};

/** Test/diagnostic hook: outstanding timer counts, used by the cleanup verifier. */
export const getTimerCounts = (): { deletion: number; userLeave: number } => ({
  deletion: pendingDeletionTimers.size,
  userLeave: pendingUserLeaveTimers.size,
});
