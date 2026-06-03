/**
 * In-memory platform metrics (per calendar day). Works without Redis.
 * Optional: persist counters to Redis when available.
 */

type DailyMetrics = {
  failedJoinAttempts: number;
  reconnectAttempts: number;
  usersBlockedLockedVanished: number;
  failedRoomJoins: number;
  uploadFailures: number;
  uploadsGcs: number;
  uploadsLocal: number;
};

const daily = new Map<string, DailyMetrics>();

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

function getDay(): DailyMetrics {
  const key = todayKey();
  if (!daily.has(key)) {
    daily.set(key, {
      failedJoinAttempts: 0,
      reconnectAttempts: 0,
      usersBlockedLockedVanished: 0,
      failedRoomJoins: 0,
      uploadFailures: 0,
      uploadsGcs: 0,
      uploadsLocal: 0,
    });
  }
  return daily.get(key)!;
}

export function recordFailedJoin(blocked = false): void {
  const m = getDay();
  m.failedJoinAttempts++;
  m.failedRoomJoins++;
  if (blocked) m.usersBlockedLockedVanished++;
}

export function recordReconnect(): void {
  getDay().reconnectAttempts++;
}

export function recordUploadGcs(): void {
  getDay().uploadsGcs++;
}

export function recordUploadLocal(): void {
  getDay().uploadsLocal++;
}

export function recordUploadFailure(): void {
  getDay().uploadFailures++;
}

export function getTodayMetrics(): DailyMetrics & {
  gcsFallbackRate: number;
  uploadSuccessRate: number;
} {
  const m = getDay();
  const totalUploads = m.uploadsGcs + m.uploadsLocal;
  const gcsFallbackRate =
    totalUploads > 0 ? Math.round((m.uploadsLocal / totalUploads) * 1000) / 10 : 0;
  const uploadAttempts = totalUploads + m.uploadFailures;
  const uploadSuccessRate =
    uploadAttempts > 0 ? Math.round((totalUploads / uploadAttempts) * 1000) / 10 : 100;

  return {
    ...m,
    gcsFallbackRate,
    uploadSuccessRate,
  };
}
