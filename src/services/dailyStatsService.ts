import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { UserVisitModel } from '../models/UserVisit.js';
import { logger } from '../utils/logger.js';

/**
 * Durable, event-driven daily/lifetime counters that don't rely on
 * live-querying Room/Message documents (both have TTL indexes and get
 * hard-deleted — see plan doc "Bug E") or on an ever-growing full-collection
 * aggregate (lifetime unique users). All keys are UTC-day-keyed and written
 * at the point of creation, mirroring the room:{code}:users SADD/SCARD
 * pattern already used elsewhere in this codebase. Redis is optional
 * platform-wide — every write here is fire-and-forget best-effort, and every
 * read degrades to 0/empty rather than throwing.
 */

const getRedis = () => getRedisClient();

const DAY_KEY_TTL_SECONDS = 35 * 24 * 60 * 60; // 35 days — covers the 30-day charts with headroom
const HOURLY_KEY_TTL_SECONDS = 3 * 24 * 60 * 60; // only "today" is ever read

export const dateKey = (d: Date = new Date()): string => d.toISOString().split('T')[0];

const last30DateKeys = (): string[] => {
  const keys: string[] = [];
  const cursor = new Date();
  for (let i = 0; i < 30; i++) {
    keys.push(dateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return keys.reverse(); // oldest -> newest, matching the existing chart ordering
};

// ---- Rooms created ---------------------------------------------------

export const recordRoomCreated = async (): Promise<void> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    const key = `stats:rooms_created:${dateKey()}`;
    await redis.pipeline().incr(key).expire(key, DAY_KEY_TTL_SECONDS).exec();
  } catch (error: unknown) {
    logger.warn('Failed to record room-created stat', { error: error instanceof Error ? error.message : String(error) });
  }
};

// ---- Messages / files / storage / hourly peak / senders --------------

export interface MessageCreatedInput {
  senderId: string;
  isFile: boolean;
  fileSizeBytes?: number;
}

export const recordMessageCreated = async ({ senderId, isFile, fileSizeBytes }: MessageCreatedInput): Promise<void> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    const today = dateKey();
    const hour = new Date().getUTCHours();
    const messagesKey = `stats:messages_sent:${today}`;
    const hourlyKey = `stats:messages_hourly:${today}`;
    const sendersKey = `stats:message_senders:${today}`;

    const pipeline = redis.pipeline();
    pipeline.incr(messagesKey).expire(messagesKey, DAY_KEY_TTL_SECONDS);
    pipeline.hincrby(hourlyKey, String(hour), 1).expire(hourlyKey, HOURLY_KEY_TTL_SECONDS);
    // senderId 'system' (auto-generated room-lifecycle messages) still counts as a
    // "sender" here, matching the pre-existing live-query behavior this replaces —
    // deliberately not filtering it out to avoid a silent semantics change.
    pipeline.sadd(sendersKey, senderId).expire(sendersKey, DAY_KEY_TTL_SECONDS);

    if (isFile) {
      const filesKey = `stats:files_shared:${today}`;
      pipeline.incr(filesKey).expire(filesKey, DAY_KEY_TTL_SECONDS);
      if (fileSizeBytes && fileSizeBytes > 0) {
        const storageKey = `stats:storage_bytes:${today}`;
        pipeline.incrby(storageKey, Math.round(fileSizeBytes)).expire(storageKey, DAY_KEY_TTL_SECONDS);
      }
    }

    await pipeline.exec();
  } catch (error: unknown) {
    logger.warn('Failed to record message-created stat', { error: error instanceof Error ? error.message : String(error) });
  }
};

const getDailySeries = async (metricPrefix: string): Promise<Array<{ date: string; count: number }>> => {
  const redis = getRedis();
  const keys = last30DateKeys();
  if (!redis || !isRedisAvailable()) {
    return keys.map((date) => ({ date, count: 0 }));
  }
  try {
    const values = await redis.mget(keys.map((date) => `stats:${metricPrefix}:${date}`));
    return keys.map((date, i) => ({ date, count: Number(values[i]) || 0 }));
  } catch (error: unknown) {
    logger.warn(`Failed to read daily series for ${metricPrefix}`, { error: error instanceof Error ? error.message : String(error) });
    return keys.map((date) => ({ date, count: 0 }));
  }
};

export const getRoomsCreatedSeries = () => getDailySeries('rooms_created');
export const getMessagesSentSeries = () => getDailySeries('messages_sent');

const getTodayCount = async (metricPrefix: string): Promise<number> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return 0;
  try {
    const value = await redis.get(`stats:${metricPrefix}:${dateKey()}`);
    return Number(value) || 0;
  } catch {
    return 0;
  }
};

export const getFilesSharedToday = () => getTodayCount('files_shared');
export const getStorageBytesToday = () => getTodayCount('storage_bytes');

export const getStorageBytesSeries = () => getDailySeries('storage_bytes');

/** Hour (0-23, UTC) with the most messages today, or null if no messages recorded yet. */
export const getPeakMessagingHourToday = async (): Promise<number | null> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return null;
  try {
    const hourly = await redis.hgetall(`stats:messages_hourly:${dateKey()}`);
    const entries = Object.entries(hourly || {});
    if (entries.length === 0) return null;
    const [peakHour] = entries.reduce((best, cur) => (Number(cur[1]) > Number(best[1]) ? cur : best));
    return Number(peakHour);
  } catch (error: unknown) {
    logger.warn('Failed to read peak messaging hour', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
};

export const getMessageSendersCountToday = async (): Promise<number> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return 0;
  try {
    return await redis.scard(`stats:message_senders:${dateKey()}`);
  } catch {
    return 0;
  }
};

export const getMessageSenderIdsToday = async (): Promise<string[]> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return [];
  try {
    return await redis.smembers(`stats:message_senders:${dateKey()}`);
  } catch {
    return [];
  }
};

// ---- Lifetime unique users (replaces an unbounded UserVisit distinct-aggregate) ----

const UNIQUE_USERS_KEY = 'stats:unique_users:lifetime';
const UNIQUE_USERS_SEEDING_LOCK = 'stats:unique_users:seeding';

export const recordUniqueVisitor = async (userId: string): Promise<void> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.sadd(UNIQUE_USERS_KEY, userId);
  } catch (error: unknown) {
    logger.warn('Failed to record unique visitor', { error: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * O(1) SCARD read, self-healed exactly once from the (accurate but
 * unbounded-cost) UserVisit distinct-userId aggregate if the set has never
 * been seeded — guarded by a short-lived Redis lock so a burst of concurrent
 * dashboard loads can't all trigger the backfill at once.
 */
export const getUniqueUsersLifetimeCount = async (): Promise<number> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return 0;
  try {
    const existing = await redis.scard(UNIQUE_USERS_KEY);
    if (existing > 0) return existing;

    const gotLock = await redis.set(UNIQUE_USERS_SEEDING_LOCK, '1', 'EX', 300, 'NX');
    if (!gotLock) {
      // Another instance is already backfilling — return the pre-backfill
      // (possibly 0) count for this one read rather than blocking on it.
      return existing;
    }

    const userIds = await UserVisitModel.distinct('userId');
    const BATCH_SIZE = 1000;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      if (batch.length > 0) await redis.sadd(UNIQUE_USERS_KEY, ...batch);
    }
    logger.info('Seeded lifetime unique-users counter from UserVisit backfill', { count: userIds.length });
    return userIds.length;
  } catch (error: unknown) {
    logger.warn('Failed to read/seed lifetime unique users', { error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
};

// ---- Peak concurrent users (true running high-water-mark) ------------

// Atomic "set only if greater" for a plain string key — GT/LT conditions are
// a sorted-set (ZADD) feature, not part of the plain SET command, so a Lua
// script is used here instead of relying on SET's flag support (which was
// the original, incorrect approach and failed on every single call in prod).
const PEAK_CONCURRENT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

export const recordPeakConcurrent = async (count: number): Promise<void> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable() || count <= 0) return;
  try {
    const key = `stats:peak_concurrent:${dateKey()}`;
    await redis.eval(PEAK_CONCURRENT_SCRIPT, 1, key, String(count), String(HOURLY_KEY_TTL_SECONDS));
  } catch (error: unknown) {
    logger.warn('Failed to record peak concurrent users', { error: error instanceof Error ? error.message : String(error) });
  }
};

export const getPeakConcurrentToday = () => getTodayCount('peak_concurrent');

// ---- Room vanish cause (fixes vanishedByAdmin/vanishedByAuto always ~0) ----

export type RoomVanishCause = 'admin' | 'auto' | 'owner';

export const recordRoomVanished = async (cause: RoomVanishCause): Promise<void> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    const key = `stats:rooms_vanished:${cause}:${dateKey()}`;
    await redis.pipeline().incr(key).expire(key, DAY_KEY_TTL_SECONDS).exec();
  } catch (error: unknown) {
    logger.warn('Failed to record room-vanished stat', { error: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * Raw per-cause counts for today. Callers combine these as needed — the
 * AdminInsights bundle merges `admin`+`owner` into `vanishedByAdmin` (both
 * are human-initiated, as opposed to the fully automatic 24h-timeout path)
 * to match the existing two-field frontend shape without a frontend change,
 * and sums all three for the legacy `vanishedToday` total.
 */
export const getRoomsVanishedTodayByCause = async (): Promise<{ admin: number; auto: number; owner: number }> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return { admin: 0, auto: 0, owner: 0 };
  try {
    const today = dateKey();
    const [admin, auto, owner] = await redis.mget(
      `stats:rooms_vanished:admin:${today}`,
      `stats:rooms_vanished:auto:${today}`,
      `stats:rooms_vanished:owner:${today}`
    );
    return { admin: Number(admin) || 0, auto: Number(auto) || 0, owner: Number(owner) || 0 };
  } catch (error: unknown) {
    logger.warn('Failed to read rooms-vanished stat', { error: error instanceof Error ? error.message : String(error) });
    return { admin: 0, auto: 0, owner: 0 };
  }
};
