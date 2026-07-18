import { GlobalStatsModel } from '../models/GlobalStats.js';
import { logger } from './logger.js';

/**
 * Durable, monotonically-incrementing counters for stats whose source
 * documents can be deleted (Room/Message TTL indexes) or whose live count
 * would otherwise require an ever-growing full-collection scan. Read with a
 * one-time self-heal: if the counter has never been set, seed it from the
 * best currently-available approximation, persist that, then increment
 * normally forever after. Moved out of adminController.ts so services
 * outside the controller layer (roomService, messageService) can use it
 * without a reverse dependency on the controller.
 */

export const getOrCreateGlobalStat = async (key: string, defaultValue = 0): Promise<number> => {
  try {
    let stat = await GlobalStatsModel.findOne({ key });
    if (!stat) {
      stat = await GlobalStatsModel.create({ key, value: defaultValue });
    }
    return stat.value;
  } catch (error: unknown) {
    logger.warn(`Failed to get global stat ${key}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return defaultValue;
  }
};

export const incrementGlobalStat = async (key: string, increment = 1): Promise<void> => {
  try {
    await GlobalStatsModel.findOneAndUpdate(
      { key },
      { $inc: { value: increment }, $set: { lastUpdated: new Date() } },
      { upsert: true, new: true }
    );
  } catch (error: unknown) {
    logger.warn(`Failed to increment global stat ${key}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Read a counter, seeding it once from `computeLiveValue` if it has never
 * been written (value 0 with no prior increments). Mirrors the existing
 * totalVisitsLifetime pattern (adminController.ts, pre-refactor). Safe to
 * call repeatedly — once seeded, the counter is authoritative and this
 * becomes a plain read.
 */
export const getSelfHealingGlobalStat = async (
  key: string,
  computeLiveValue: () => Promise<number>
): Promise<number> => {
  const cached = await getOrCreateGlobalStat(key);
  if (cached > 0) return cached;

  try {
    const live = await computeLiveValue();
    if (live > 0) {
      await GlobalStatsModel.findOneAndUpdate(
        { key },
        { $set: { value: live, lastUpdated: new Date() } },
        { upsert: true }
      );
    }
    return live;
  } catch (error: unknown) {
    logger.warn(`Failed to self-heal global stat ${key}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return cached;
  }
};
