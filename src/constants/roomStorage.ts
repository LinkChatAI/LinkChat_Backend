import { RoomPlan } from '../types/index.js';

/** Storage caps per subscription plan (bytes). */
export const PLAN_STORAGE_LIMITS: Record<RoomPlan, number> = {
  free:       100 * 1024 * 1024,   // 100 MB
  premium:    500 * 1024 * 1024,   // 500 MB
  pro:       2048 * 1024 * 1024,   //   2 GB
  enterprise: 10 * 1024 * 1024 * 1024, // 10 GB
};

/** Returns the storage cap (bytes) for the given plan. Defaults to free tier. */
export function getStorageLimitForPlan(plan?: string | null): number {
  return PLAN_STORAGE_LIMITS[(plan as RoomPlan) ?? 'free'] ?? PLAN_STORAGE_LIMITS.free;
}

/** Legacy constant — kept for backward-compat. Equals the free-tier limit. */
export const ROOM_STORAGE_LIMIT_BYTES = PLAN_STORAGE_LIMITS.free;
