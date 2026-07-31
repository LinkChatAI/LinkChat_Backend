import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { logger } from '../utils/logger.js';

/**
 * Background-job run history for the Server Monitoring dashboard. Both the
 * in-process setInterval workers (cleanupService/autoVanishService/
 * subscriptionExpiryService) and the Cloud-Scheduler-triggered HTTP path
 * (maintenanceController's JOBS registry) call the SAME underlying job
 * functions — wrapping each call site with recordJobRun writes to the same
 * Redis hash regardless of which trigger fired it, so "last run" always
 * reflects whichever happened most recently. Fails open (job still runs and
 * its result/throw is unchanged) if Redis is unavailable.
 */

export const KNOWN_JOB_NAMES = [
  'cleanup',
  'auto-vanish',
  'subscription-expiry',
  'orphaned-uploads',
  'reconcile-orphans',
] as const;

export type JobName = (typeof KNOWN_JOB_NAMES)[number];

export interface JobHealth {
  name: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastSuccess: boolean | null;
  lastError: string | null;
  runCount: number;
}

const jobKey = (name: string) => `monitoring:jobs:${name}`;

export const recordJobRun = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const startedAt = Date.now();
  try {
    const result = await fn();
    void persistJobResult(name, startedAt, true, null);
    return result;
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    void persistJobResult(name, startedAt, false, message);
    throw error;
  }
};

const persistJobResult = async (
  name: string,
  startedAt: number,
  success: boolean,
  errorMessage: string | null
): Promise<void> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return;

  try {
    await redis
      .multi()
      .hset(jobKey(name), {
        lastRunAt: new Date(startedAt).toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastSuccess: success ? '1' : '0',
        lastError: errorMessage || '',
      })
      .hincrby(jobKey(name), 'runCount', 1)
      .exec();
  } catch (error: any) {
    logger.warn('Failed to record job run for monitoring', {
      job: name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const getJobsHealth = async (): Promise<JobHealth[]> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) {
    return KNOWN_JOB_NAMES.map((name) => ({
      name,
      lastRunAt: null,
      lastDurationMs: null,
      lastSuccess: null,
      lastError: null,
      runCount: 0,
    }));
  }

  try {
    const pipeline = redis.pipeline();
    KNOWN_JOB_NAMES.forEach((name) => pipeline.hgetall(jobKey(name)));
    const results = await pipeline.exec();

    return KNOWN_JOB_NAMES.map((name, i) => {
      const data = (results?.[i]?.[1] as Record<string, string> | undefined) || {};
      return {
        name,
        lastRunAt: data.lastRunAt || null,
        lastDurationMs: data.lastDurationMs ? parseInt(data.lastDurationMs, 10) : null,
        lastSuccess: data.lastSuccess === undefined ? null : data.lastSuccess === '1',
        lastError: data.lastError || null,
        runCount: data.runCount ? parseInt(data.runCount, 10) : 0,
      };
    });
  } catch (error: any) {
    logger.warn('Failed to read jobs health for monitoring', {
      error: error instanceof Error ? error.message : String(error),
    });
    return KNOWN_JOB_NAMES.map((name) => ({
      name,
      lastRunAt: null,
      lastDurationMs: null,
      lastSuccess: null,
      lastError: null,
      runCount: 0,
    }));
  }
};
