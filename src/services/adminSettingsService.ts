import { AdminSettingsModel, IAdminSettings } from '../models/AdminSetting.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Runtime-configurable platform rules, served from an in-process cache.
 *
 * COST CONTRACT — this service is read from hot paths (room create, join,
 * upload), so it must never add a per-request DB round trip:
 *   - One Mongo findOne at most every CACHE_TTL_MS (60s) per instance. At the
 *     documented 10-instance ceiling that is 10 reads/minute platform-wide,
 *     independent of traffic.
 *   - getSettingsSync() is fully synchronous and allocation-free for callers
 *     that cannot await (or that must not risk latency); it returns the last
 *     cached value, or env-derived defaults before the first load completes.
 *   - Any Mongo failure degrades to defaults and logs a warning. Settings are
 *     never load-bearing for availability: if this collection is unreachable,
 *     the platform behaves exactly as it did before this feature existed.
 */

export interface AdminSettingsValues {
  defaultRoomExpiryHours: number;
  autoVanishHours: number;
  maxParticipantsPerRoom: number; // 0 = unlimited
  adminLeaveGraceMinutes: number;
  maxFileSizeMb: number;
  fileUploadsEnabled: boolean;
  roomCreationEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

/**
 * Defaults mirror the pre-existing env/constant behaviour exactly, so an
 * empty settings collection is behaviourally identical to the old build:
 *   - defaultRoomExpiryHours  <- env.DEFAULT_ROOM_EXP_HOURS (0.833333 = 50min)
 *   - autoVanishHours         <- autoVanishService's AUTO_VANISH_HOURS (24)
 *   - maxFileSizeMb           <- env.MAX_FILE_SIZE_BYTES (300MB)
 *   - maxParticipantsPerRoom  <- 0, i.e. unlimited, which is what the join
 *     path enforced before (no cap existed anywhere in the codebase).
 *   - adminLeaveGraceMinutes  <- 60, matching the grace period that was
 *     previously hardcoded in roomLifecycleHandlers' leave/disconnect timers.
 */
export const getDefaultSettings = (): AdminSettingsValues => ({
  defaultRoomExpiryHours: env.DEFAULT_ROOM_EXP_HOURS,
  autoVanishHours: 24,
  maxParticipantsPerRoom: 0,
  adminLeaveGraceMinutes: 60,
  maxFileSizeMb: Math.round(env.MAX_FILE_SIZE_BYTES / (1024 * 1024)),
  fileUploadsEnabled: true,
  roomCreationEnabled: true,
  maintenanceMode: false,
  maintenanceMessage: '',
});

const CACHE_TTL_MS = 60_000;

let cache: { data: AdminSettingsValues; at: number } | null = null;
let inFlight: Promise<AdminSettingsValues> | null = null;

const toValues = (doc: IAdminSettings | null): AdminSettingsValues => {
  const defaults = getDefaultSettings();
  if (!doc) return defaults;
  return {
    defaultRoomExpiryHours: doc.defaultRoomExpiryHours ?? defaults.defaultRoomExpiryHours,
    autoVanishHours: doc.autoVanishHours ?? defaults.autoVanishHours,
    maxParticipantsPerRoom: doc.maxParticipantsPerRoom ?? defaults.maxParticipantsPerRoom,
    adminLeaveGraceMinutes: doc.adminLeaveGraceMinutes ?? defaults.adminLeaveGraceMinutes,
    maxFileSizeMb: doc.maxFileSizeMb ?? defaults.maxFileSizeMb,
    fileUploadsEnabled: doc.fileUploadsEnabled ?? defaults.fileUploadsEnabled,
    roomCreationEnabled: doc.roomCreationEnabled ?? defaults.roomCreationEnabled,
    maintenanceMode: doc.maintenanceMode ?? defaults.maintenanceMode,
    maintenanceMessage: doc.maintenanceMessage ?? defaults.maintenanceMessage,
  };
};

/**
 * Cached settings read. Single-flight: concurrent callers during a cache miss
 * share one Mongo query rather than stampeding it (same pattern as
 * adminInsightsService's getDashboardInsightsCached).
 */
export const getSettings = async (): Promise<AdminSettingsValues> => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const doc = await AdminSettingsModel.findById('global').lean().exec();
      const values = toValues(doc as IAdminSettings | null);
      cache = { data: values, at: Date.now() };
      return values;
    } catch (error: unknown) {
      logger.warn('Failed to load admin settings, using defaults', {
        error: error instanceof Error ? error.message : String(error),
      });
      const values = cache?.data ?? getDefaultSettings();
      // Cache the fallback too, so a Mongo outage doesn't retry on every call.
      cache = { data: values, at: Date.now() };
      return values;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
};

/**
 * Synchronous best-effort read for call sites that cannot await. Returns the
 * last cached value, or defaults if nothing has been loaded yet. Safe to call
 * from anywhere; never throws, never blocks.
 */
export const getSettingsSync = (): AdminSettingsValues => cache?.data ?? getDefaultSettings();

/** Drop the cache so the next read reflects a just-written update. */
export const invalidateSettingsCache = (): void => {
  cache = null;
};

/**
 * Upsert the singleton. Returns the persisted values. Callers are responsible
 * for validating input (see adminSettingsController's zod schema) — this layer
 * only enforces the Mongoose schema's min/max bounds.
 */
export const updateSettings = async (
  patch: Partial<AdminSettingsValues>,
  updatedBy: string
): Promise<AdminSettingsValues> => {
  const doc = await AdminSettingsModel.findByIdAndUpdate(
    'global',
    { $set: { ...patch, updatedBy } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  const values = toValues(doc as IAdminSettings | null);
  cache = { data: values, at: Date.now() };
  logger.info('Admin settings updated', { updatedBy, keys: Object.keys(patch) });
  return values;
};

/**
 * Warm the cache at boot so the first room create/join doesn't pay the read.
 * Fire-and-forget; failures are already handled inside getSettings.
 */
export const primeSettingsCache = (): void => {
  getSettings().catch(() => {});
};
