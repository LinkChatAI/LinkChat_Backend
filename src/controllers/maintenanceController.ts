import { Request, Response } from 'express';
import { runCleanupTick } from '../services/cleanupService.js';
import { reconcileOrphanedRoomData } from '../services/roomReconcileService.js';
import { processAutoVanish } from '../services/autoVanishService.js';
import { expireDueSubscriptions } from '../services/subscriptionService.js';
import { reapOrphanedUploads } from '../services/orphanedUploadService.js';
import { logger } from '../utils/logger.js';
import { recordJobRun } from '../services/jobHealthService.js';

const JOBS: Record<string, () => Promise<unknown>> = {
  // Expired + ended rooms. This is the only mechanism that deletes expired
  // rooms now that Room.expiresAt has no TTL index, so it must stay scheduled.
  cleanup: runCleanupTick,
  'auto-vanish': processAutoVanish,
  'subscription-expiry': expireDueSubscriptions,
  // Not started as an in-process timer anywhere (no correctness deadline the
  // way the other three have) — runs only when Cloud Scheduler calls it.
  // Recommended cadence: once a day.
  'orphaned-uploads': reapOrphanedUploads,
  // Sweeps resources whose owning Room is already gone — the backlog left by
  // the old TTL-index behaviour, plus anything a partially-failed purge drops.
  // Recommended cadence: once a day.
  'reconcile-orphans': reconcileOrphanedRoomData,
};

/**
 * HTTP-triggerable counterpart to the setInterval workers started in index.ts.
 * Meant to be called by Cloud Scheduler (POST, header `x-admin-secret` or
 * `Authorization: Bearer <ADMIN_SECRET>` — same as every other admin route)
 * once ENABLE_IN_PROCESS_TIMERS=false lets the instance scale to zero between
 * requests: a bare setInterval stalls when there's no in-flight request to
 * allocate CPU, but a Scheduler-triggered HTTP hit is a real request and runs
 * reliably regardless of instance scale state.
 *
 * POST /api/admin/maintenance/run          — runs cleanup + auto-vanish + subscription-expiry
 * POST /api/admin/maintenance/run?job=cleanup|auto-vanish|subscription-expiry
 *                                     |orphaned-uploads|reconcile-orphans
 *
 * "orphaned-uploads" and "reconcile-orphans" are intentionally excluded from
 * the no-`job` (run-everything) default — they're lower-urgency, once-a-day
 * jobs, not something that needs to ride along with the others' more frequent
 * schedules.
 */
const LOW_FREQUENCY_JOBS = new Set(['orphaned-uploads', 'reconcile-orphans']);
const DEFAULT_JOBS = Object.keys(JOBS).filter((name) => !LOW_FREQUENCY_JOBS.has(name));

export const runMaintenanceJobs = async (req: Request, res: Response): Promise<void> => {
  const requested = typeof req.query.job === 'string' ? req.query.job : undefined;
  const jobNames = requested ? [requested] : DEFAULT_JOBS;

  const results: Record<string, { ok: boolean; error?: string }> = {};

  for (const name of jobNames) {
    const job = JOBS[name];
    if (!job) {
      results[name] = { ok: false, error: 'unknown job' };
      continue;
    }
    try {
      await recordJobRun(name, job);
      results[name] = { ok: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Maintenance job "${name}" failed`, { error: message });
      results[name] = { ok: false, error: message };
    }
  }

  const allOk = Object.values(results).every((r) => r.ok);
  res.status(allOk ? 200 : 207).json({ results, timestamp: new Date().toISOString() });
};
