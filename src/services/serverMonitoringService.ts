import fs from 'fs';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getMetricsSummaryJson } from './metricsService.js';
import { getTodayMetrics } from './platformMetricsService.js';
import { getPlatformUsersOnline } from './roomPresenceService.js';
import { probeGcsHealth } from './gcsService.js';

/**
 * Core of the Server Monitoring admin module. Everything here is built on
 * infrastructure the app already pays for — the shared Redis client and
 * prom-client counters/gauges from metricsService.ts — with no new datastore
 * and no new npm dependency. See the "Server Monitoring module" plan for the
 * full design rationale (Redis key table, cost tradeoffs).
 *
 * `isAnyAdminConnectedLite` intentionally duplicates (rather than imports)
 * the presence-check from socket/adminHandlers.ts: adminHandlers.ts will
 * import from this file too (to ride the lightweight monitoring snapshot
 * along on its existing stats_update heartbeat), and importing the other
 * direction here would create a circular module dependency. The check itself
 * is a handful of lines reading a key adminHandlers.ts already
 * writes/refreshes, so duplicating the read side is cheap and safe.
 */

// ── Redis keys & caps ────────────────────────────────────────────────────────
const HISTORY_KEY = 'monitoring:history';
const HISTORY_CAP = 2880; // 48h @ 1-minute ticks, ~250 bytes/entry ≈ 720KB
const LIST_TTL_S = 172800; // 48h — self-heals if writes ever stop
const ALERTS_KEY = 'monitoring:alerts';
const ALERTS_CAP = 100;
const SECURITY_EVENTS_KEY = 'monitoring:security:events';
const SECURITY_EVENTS_CAP = 200;
const SECURITY_FAILCOUNT_KEY = 'monitoring:security:failcount';
const SECURITY_FAILCOUNT_TTL_S = 600; // rolling 10-minute window
const ADMIN_PRESENCE_KEY = 'admin:presence'; // written by socket/adminHandlers.ts
const ADMIN_ROOM = 'admin:insights';

// Matches backend/cloudbuild.yaml's `--memory 256Mi` deploy flag. Not read
// from the cgroup directly, so this is an approximation — overridable via env
// var if the deploy config ever changes without this file being updated.
const MEMORY_LIMIT_MB = parseInt(process.env.MONITORING_MEMORY_LIMIT_MB || '256', 10);
const MONGO_PING_EVERY_N_TICKS = 5; // ~5 minutes at the default 60s tick

const ALERT_THRESHOLDS = {
  cpuPct: { warning: 85, critical: 95 },
  memPct: { warning: 80, critical: 92 },
  eventLoopLagMs: { warning: 100, critical: 300 },
  apiErrorRatePct: { warning: 5, critical: 15 },
} as const;

/**
 * Cloud Run can run up to 3 concurrent backend instances (see
 * backend/cloudbuild.yaml --max-instances 3), each running its own snapshot
 * tick and writing to the SAME shared Redis history/alerts lists — without an
 * identity attached, those interleave into one misleading chart mixing
 * different processes' CPU/RAM. K_REVISION is shared by every instance of a
 * deploy, so a random per-boot suffix is what actually distinguishes them.
 */
const INSTANCE_ID = `${process.env.K_REVISION || 'local'}-${crypto.randomUUID().slice(0, 8)}`;

export interface MonitoringSnapshot {
  ts: string;
  instanceId: string;
  cpuPct: number;
  memPct: number;
  rssMb: number;
  eventLoopLagMs: number;
  uptimeSec: number;
  connectedSockets: number;
  usersOnline: number | null;
  activeRoomsApprox: number | null;
  mongoOk: boolean;
  redisOk: boolean;
  socketAdapter: 'redis' | 'memory';
  apiErrorRatePct: number;
  messagesSentTotal: number;
  bytesInTotal: number;
  bytesOutTotal: number;
}

type AlertSeverity = 'warning' | 'critical';

export interface AlertEvent {
  ts: string;
  instanceId: string;
  type: string;
  severity: AlertSeverity | 'resolved';
  message: string;
  value: number;
}

export interface SecurityEvent {
  ts: string;
  ip: string;
  type: string;
  endpoint?: string;
  userAgent?: string;
}

// ── CPU / RAM / disk sampling (no new npm dependency) ────────────────────────

let lastCpuUsage = process.cpuUsage();
let lastCpuSampleAt = Date.now();

/** % of one vCPU used since the previous sample (Cloud Run here runs --cpu 1). */
const sampleCpuPct = (): number => {
  const now = Date.now();
  const elapsedMs = now - lastCpuSampleAt;
  const delta = process.cpuUsage(lastCpuUsage); // diff since lastCpuUsage was captured
  lastCpuUsage = process.cpuUsage();
  lastCpuSampleAt = now;
  if (elapsedMs <= 0) return 0;
  const usedMicros = delta.user + delta.system;
  return Math.round(Math.min(100, (usedMicros / 1000 / elapsedMs) * 100) * 10) / 10;
};

let prevApiTotalRequests = 0;
let prevApiErrorRequests = 0;

/**
 * Error rate over the interval since the last tick, not a lifetime average —
 * diffing the cumulative counters each tick (the same technique as
 * Prometheus's `rate()`) so a brief error burst early in a long-running
 * instance's life doesn't permanently distort the figure, and a real ongoing
 * problem isn't diluted into invisibility by months of prior healthy traffic.
 */
const sampleApiErrorRatePct = (apiRequestsByClass: Record<'2xx' | '3xx' | '4xx' | '5xx', number>): number => {
  const totalNow = Object.values(apiRequestsByClass).reduce((sum, n) => sum + n, 0);
  const errorNow = apiRequestsByClass['4xx'] + apiRequestsByClass['5xx'];
  const deltaTotal = totalNow - prevApiTotalRequests;
  const deltaError = errorNow - prevApiErrorRequests;
  prevApiTotalRequests = totalNow;
  prevApiErrorRequests = errorNow;
  if (deltaTotal <= 0) return 0;
  return Math.round(Math.min(100, (deltaError / deltaTotal) * 100) * 10) / 10;
};

const sampleMemory = () => {
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const memPct = Math.round(Math.min(100, (rssMb / MEMORY_LIMIT_MB) * 100) * 10) / 10;
  return { rssMb, memPct, heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024), heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024) };
};

/**
 * Cloud Run's filesystem is an ephemeral overlay, so this is informational
 * only. fs.promises.statfs requires Node 18.15+ — feature-detected rather
 * than assumed, so an older/alternate runtime degrades to "not available"
 * instead of throwing.
 */
const sampleDisk = async (): Promise<{ available: boolean; totalMb?: number; usedMb?: number; usedPct?: number }> => {
  const statfs = (fs.promises as any).statfs;
  if (typeof statfs !== 'function') return { available: false };
  try {
    const stats = await statfs('/');
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      available: true,
      totalMb: Math.round(totalBytes / 1024 / 1024),
      usedMb: Math.round(usedBytes / 1024 / 1024),
      usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return { available: false };
  }
};

// ── Admin presence (read-only reuse of adminHandlers.ts's key) ──────────────

const isAnyAdminConnectedLite = async (io: Server): Promise<boolean> => {
  const localRoom = io.sockets.adapter.rooms.get(ADMIN_ROOM);
  if (localRoom && localRoom.size > 0) return true;
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      return (await redis.exists(ADMIN_PRESENCE_KEY)) === 1;
    } catch {
      return false;
    }
  }
  return false;
};

/** Per-instance approximation (Socket.IO room membership isn't cheaply enumerable across instances via the Redis adapter). */
const getActiveRoomsApprox = (io: Server): number => {
  const socketIds = io.sockets.sockets;
  let count = 0;
  for (const roomName of io.sockets.adapter.rooms.keys()) {
    if (roomName === ADMIN_ROOM || socketIds.has(roomName)) continue; // skip per-socket private rooms
    count++;
  }
  return count;
};

// ── Cloud service health (cached, refreshed on the snapshot tick) ───────────

interface CloudHealth {
  mongoOk: boolean;
  mongoDetail: { readyState: number; host?: string; database?: string };
  redisOk: boolean;
  socketAdapter: 'redis' | 'memory';
  updatedAt: string;
}

let cachedCloudHealth: CloudHealth = {
  mongoOk: false,
  mongoDetail: { readyState: 0 },
  redisOk: false,
  socketAdapter: 'memory',
  updatedAt: new Date(0).toISOString(),
};

let tickCount = 0;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

const refreshCloudHealth = async (getAdapterStatus: () => 'redis' | 'memory'): Promise<void> => {
  const readyState = mongoose.connection.readyState;
  let mongoOk = readyState === 1;

  // A real ping (not just readyState) only every ~5 minutes — cheap enough to
  // matter little, but no reason to hit it every 60s.
  if (mongoOk && mongoose.connection.db && tickCount % MONGO_PING_EVERY_N_TICKS === 0) {
    try {
      await withTimeout(mongoose.connection.db.admin().ping(), 3000);
    } catch {
      mongoOk = false;
    }
  }

  cachedCloudHealth = {
    mongoOk,
    mongoDetail: {
      readyState,
      host: mongoose.connection.host,
      database: mongoose.connection.db?.databaseName,
    },
    redisOk: isRedisAvailable(),
    socketAdapter: getAdapterStatus(),
    updatedAt: new Date().toISOString(),
  };
};

export const getCloudServicesHealth = (): CloudHealth => cachedCloudHealth;

// ── Capped-list Redis helpers ────────────────────────────────────────────────

const pushCapped = async (key: string, value: unknown, cap: number, ttlSeconds: number): Promise<void> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.multi().rpush(key, JSON.stringify(value)).ltrim(key, -cap, -1).expire(key, ttlSeconds).exec();
  } catch (error: any) {
    logger.warn('Monitoring: failed to push capped list', { key, error: error instanceof Error ? error.message : String(error) });
  }
};

const readCapped = async <T>(key: string, limit?: number): Promise<T[]> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return [];
  try {
    const raw = limit ? await redis.lrange(key, -limit, -1) : await redis.lrange(key, 0, -1);
    return raw
      .map((r: string) => {
        try {
          return JSON.parse(r) as T;
        } catch {
          return null;
        }
      })
      .filter((v: T | null): v is T => v !== null)
      .reverse(); // newest first
  } catch (error: any) {
    logger.warn('Monitoring: failed to read capped list', { key, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
};

// ── Alert evaluation (edge-triggered — one entry per state change, not per tick) ──

const activeAlerts = new Map<string, AlertSeverity>();

const evaluateThreshold = async (
  type: string,
  value: number,
  thresholds: { warning: number; critical: number },
  formatMessage: (severity: AlertSeverity, value: number) => string
): Promise<void> => {
  const severity: AlertSeverity | null =
    value >= thresholds.critical ? 'critical' : value >= thresholds.warning ? 'warning' : null;
  const previous = activeAlerts.get(type) || null;

  if (severity && severity !== previous) {
    activeAlerts.set(type, severity);
    await pushCapped(
      ALERTS_KEY,
      { ts: new Date().toISOString(), instanceId: INSTANCE_ID, type, severity, message: `[${INSTANCE_ID}] ${formatMessage(severity, value)}`, value },
      ALERTS_CAP,
      LIST_TTL_S
    );
  } else if (!severity && previous) {
    activeAlerts.delete(type);
    await pushCapped(
      ALERTS_KEY,
      { ts: new Date().toISOString(), instanceId: INSTANCE_ID, type, severity: 'resolved', message: `[${INSTANCE_ID}] ${type} back to normal`, value },
      ALERTS_CAP,
      LIST_TTL_S
    );
  }
};

const evaluateBoolean = async (type: string, isBad: boolean, severity: AlertSeverity, message: string): Promise<void> => {
  const previous = activeAlerts.get(type) || null;
  if (isBad && !previous) {
    activeAlerts.set(type, severity);
    await pushCapped(
      ALERTS_KEY,
      { ts: new Date().toISOString(), instanceId: INSTANCE_ID, type, severity, message: `[${INSTANCE_ID}] ${message}`, value: 1 },
      ALERTS_CAP,
      LIST_TTL_S
    );
  } else if (!isBad && previous) {
    activeAlerts.delete(type);
    await pushCapped(
      ALERTS_KEY,
      { ts: new Date().toISOString(), instanceId: INSTANCE_ID, type, severity: 'resolved', message: `[${INSTANCE_ID}] ${type} resolved`, value: 0 },
      ALERTS_CAP,
      LIST_TTL_S
    );
  }
};

// ── Snapshot tick ─────────────────────────────────────────────────────────────

let latestSnapshot: MonitoringSnapshot | null = null;
let lastUsersOnline: number | null = null;
let lastActiveRoomsApprox: number | null = null;

export const getLatestSnapshot = (): MonitoringSnapshot | null => latestSnapshot;

export const startMonitoringSnapshotJob = (
  io: Server,
  getAdapterStatus: () => 'redis' | 'memory',
  intervalMs = 60000
): NodeJS.Timeout => {
  const tick = async (): Promise<void> => {
    try {
      const cpuPct = sampleCpuPct();
      const { rssMb, memPct } = sampleMemory();
      await refreshCloudHealth(getAdapterStatus);
      const health = getCloudServicesHealth();

      // Only pay for the cross-instance presence scan (getPlatformUsersOnline)
      // and the local room enumeration when an admin is actually watching —
      // otherwise carry forward the last known value so the history chart
      // doesn't show artificial drops to zero while nobody's looking.
      if (await isAnyAdminConnectedLite(io)) {
        lastUsersOnline = await getPlatformUsersOnline();
        lastActiveRoomsApprox = getActiveRoomsApprox(io);
      }

      const metricsSummary = getMetricsSummaryJson();

      const snapshot: MonitoringSnapshot = {
        ts: new Date().toISOString(),
        instanceId: INSTANCE_ID,
        cpuPct,
        memPct,
        rssMb,
        eventLoopLagMs: metricsSummary.eventLoopLagMs,
        uptimeSec: Math.round(process.uptime()),
        connectedSockets: metricsSummary.connectedSockets,
        usersOnline: lastUsersOnline,
        activeRoomsApprox: lastActiveRoomsApprox,
        mongoOk: health.mongoOk,
        redisOk: health.redisOk,
        socketAdapter: health.socketAdapter,
        apiErrorRatePct: sampleApiErrorRatePct(metricsSummary.apiRequestsByClass),
        messagesSentTotal: metricsSummary.messagesSentTotal,
        bytesInTotal: metricsSummary.bytesInTotal,
        bytesOutTotal: metricsSummary.bytesOutTotal,
      };

      latestSnapshot = snapshot;
      tickCount++;

      await pushCapped(HISTORY_KEY, snapshot, HISTORY_CAP, LIST_TTL_S);

      await evaluateThreshold('cpu', cpuPct, ALERT_THRESHOLDS.cpuPct, (sev, v) => `CPU usage ${sev} — ${v}%`);
      await evaluateThreshold('memory', memPct, ALERT_THRESHOLDS.memPct, (sev, v) => `Memory usage ${sev} — ${v}%`);
      await evaluateThreshold(
        'eventLoopLag',
        snapshot.eventLoopLagMs,
        ALERT_THRESHOLDS.eventLoopLagMs,
        (sev, v) => `Event loop lag ${sev} — ${v}ms`
      );
      await evaluateThreshold(
        'apiErrorRate',
        snapshot.apiErrorRatePct,
        ALERT_THRESHOLDS.apiErrorRatePct,
        (sev, v) => `API error rate ${sev} — ${v.toFixed(1)}%`
      );
      await evaluateBoolean('mongoDown', !snapshot.mongoOk, 'critical', 'MongoDB connection lost');
      await evaluateBoolean(
        'redisDown',
        !snapshot.redisOk,
        'warning',
        'Redis unavailable — rate limiting/caching/history are running fail-open'
      );
    } catch (error: any) {
      logger.warn('Monitoring snapshot tick failed', { error: error instanceof Error ? error.message : String(error) });
    }
  };

  void tick();
  return setInterval(tick, intervalMs);
};

export const stopMonitoringSnapshotJob = (handle: NodeJS.Timeout | null): void => {
  if (handle) clearInterval(handle);
};

// ── Public read APIs (used by adminMonitoringController.ts) ─────────────────

export const getHistory = async (rangeHours: number): Promise<MonitoringSnapshot[]> => {
  const limit = Math.min(HISTORY_CAP, Math.max(1, Math.round(rangeHours * 60)));
  const entries = await readCapped<MonitoringSnapshot>(HISTORY_KEY, limit);
  return entries.reverse(); // chronological (oldest -> newest) for charting
};

export const getAlerts = (limit = 100): Promise<AlertEvent[]> => readCapped<AlertEvent>(ALERTS_KEY, limit);

export const recordSecurityEvent = async (details: {
  ip: string;
  type: string;
  endpoint?: string;
  userAgent?: string;
}): Promise<void> => {
  await pushCapped(SECURITY_EVENTS_KEY, { ts: new Date().toISOString(), ...details }, SECURITY_EVENTS_CAP, LIST_TTL_S);

  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      await redis.multi().incr(SECURITY_FAILCOUNT_KEY).expire(SECURITY_FAILCOUNT_KEY, SECURITY_FAILCOUNT_TTL_S).exec();
    } catch {
      /* non-critical */
    }
  }
};

export const getSecurityEvents = async (
  limit = 200
): Promise<{ events: SecurityEvent[]; failuresLast10Min: number }> => {
  const events = await readCapped<SecurityEvent>(SECURITY_EVENTS_KEY, limit);

  let failuresLast10Min = 0;
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      failuresLast10Min = parseInt((await redis.get(SECURITY_FAILCOUNT_KEY)) || '0', 10);
    } catch {
      /* ignore */
    }
  }

  return { events, failuresLast10Min };
};

/**
 * Reuses gcsService.ts's probeGcsHealth() — already called on every real
 * upload-URL request with its own 5-minute cache — instead of issuing a
 * separate bucket.exists() call here. Zero incremental GCS API cost.
 */
export const getStorageUsage = async (): Promise<{
  gcsConfigured: boolean;
  gcsReachable: boolean | null;
  bucketName?: string;
  today: ReturnType<typeof getTodayMetrics>;
}> => {
  const today = getTodayMetrics();
  if (!env.GCS_BUCKET) {
    return { gcsConfigured: false, gcsReachable: null, today };
  }

  let gcsReachable: boolean | null = null;
  try {
    gcsReachable = await probeGcsHealth();
  } catch (error: any) {
    gcsReachable = false;
    logger.warn('GCS reachability check failed', { error: error instanceof Error ? error.message : String(error) });
  }

  return { gcsConfigured: true, gcsReachable, bucketName: env.GCS_BUCKET, today };
};

export const getEnvironmentInfo = () => {
  const service = process.env.K_SERVICE || null;
  const projectId = env.GCS_PROJECT_ID;
  // Deep link to the Cloud Logging console for this service, when we know
  // both which Cloud Run service we are and which GCP project it's in —
  // covers the "Logs" tab's full-history gap left by the in-memory ring
  // buffer (which only holds this instance's last ~1000 lines).
  const cloudLoggingUrl =
    service && projectId
      ? `https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%20resource.labels.service_name%3D%22${encodeURIComponent(
          service
        )}%22?project=${encodeURIComponent(projectId)}`
      : null;

  return {
    nodeEnv: env.NODE_ENV,
    service,
    revision: process.env.K_REVISION || null,
    configuration: process.env.K_CONFIGURATION || null,
    nodeVersion: process.version,
    pid: process.pid,
    cloudLoggingUrl,
    // Distinguishes this specific process from sibling Cloud Run instances of
    // the same revision — see the INSTANCE_ID comment above. Whichever
    // instance happens to answer a given /overview request is the one shown.
    instanceId: INSTANCE_ID,
  };
};

export const getDiskUsage = sampleDisk;
