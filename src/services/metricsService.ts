import client from 'prom-client';
import { monitorEventLoopDelay } from 'perf_hooks';
import { logger } from '../utils/logger.js';

/**
 * Runtime metrics for capacity planning and load-test verification. Exposed
 * at GET /metrics (see index.ts, gated by authenticateAdmin) in Prometheus
 * text exposition format, and summarized periodically via the logger so the
 * headline numbers show up in Cloud Logging even without a scraper wired up.
 */

const register = new client.Registry();
client.collectDefaultMetrics({ register });

let connectedSockets = 0;
let messagesSentTotal = 0;
let bytesInTotal = 0;
let bytesOutTotal = 0;
const apiRequestsByClass: Record<'2xx' | '3xx' | '4xx' | '5xx', number> = {
  '2xx': 0,
  '3xx': 0,
  '4xx': 0,
  '5xx': 0,
};
let adminCacheHits = 0;
let adminCacheMisses = 0;

const connectedSocketsGauge = new client.Gauge({
  name: 'chat_connected_sockets',
  help: 'Number of currently connected Socket.IO clients on this instance',
  registers: [register],
});

const roomParticipantsGauge = new client.Gauge({
  name: 'chat_room_participants',
  help: 'Participant count per room, sampled whenever a join/leave recomputes it',
  labelNames: ['room'] as const,
  registers: [register],
});

const messagesSentCounter = new client.Counter({
  name: 'chat_messages_sent_total',
  help: 'Total chat messages sent across all rooms on this instance',
  registers: [register],
});

const broadcastLatencyHistogram = new client.Histogram({
  name: 'chat_message_broadcast_latency_ms',
  help: 'Time from receiving sendMessage to completing the room broadcast emit',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [register],
});

// Approximate application-level payload bytes (JSON message size, times
// recipient count on the way out) — NOT raw socket/TLS wire bytes. Cheap to
// compute at points we already touch for latency tracking, and good enough
// for a "bandwidth" order-of-magnitude on the monitoring dashboard.
const bytesInCounter = new client.Counter({
  name: 'chat_bytes_in_total',
  help: 'Approximate application-level bytes received (message payload sizes)',
  registers: [register],
});

const bytesOutCounter = new client.Counter({
  name: 'chat_bytes_out_total',
  help: 'Approximate application-level bytes sent (message payload size x recipients)',
  registers: [register],
});

// Labeled only by status-class (2xx/3xx/4xx/5xx), never by path — a per-path
// label would be unbounded cardinality across room-scoped routes.
const apiRequestsCounter = new client.Counter({
  name: 'api_requests_total',
  help: 'Total HTTP requests handled, labeled by response status class',
  labelNames: ['statusClass'] as const,
  registers: [register],
});

const adminCacheHitCounter = new client.Counter({
  name: 'admin_cache_hit_total',
  help: 'Admin dashboard Redis response-cache hits',
  registers: [register],
});

const adminCacheMissCounter = new client.Counter({
  name: 'admin_cache_miss_total',
  help: 'Admin dashboard Redis response-cache misses',
  registers: [register],
});

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

// eslint-disable-next-line no-new
new client.Gauge({
  name: 'chat_event_loop_lag_ms',
  help: 'Mean event loop lag since the last scrape',
  registers: [register],
  collect() {
    this.set(eventLoopDelay.mean / 1e6);
    eventLoopDelay.reset();
  },
});

export const trackSocketConnected = (): void => {
  connectedSockets += 1;
  connectedSocketsGauge.set(connectedSockets);
};

export const trackSocketDisconnected = (): void => {
  connectedSockets = Math.max(0, connectedSockets - 1);
  connectedSocketsGauge.set(connectedSockets);
};

export const setRoomParticipantCount = (roomCode: string, count: number): void => {
  roomParticipantsGauge.set({ room: roomCode }, count);
};

/**
 * Drop a room's gauge series. `room` is a high-cardinality label — one series
 * per room code, retained by prom-client forever unless explicitly removed —
 * so without this every room ever created stays in the registry and is
 * re-serialized on every /metrics scrape.
 */
export const removeRoomMetrics = (roomCode: string): void => {
  roomParticipantsGauge.remove({ room: roomCode });
};

export const recordMessageSent = (): void => {
  messagesSentCounter.inc();
  messagesSentTotal += 1;
};

export const observeBroadcastLatencyMs = (ms: number): void => {
  broadcastLatencyHistogram.observe(ms);
};

export const recordBytesIn = (bytes: number): void => {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  bytesInCounter.inc(bytes);
  bytesInTotal += bytes;
};

export const recordBytesOut = (bytes: number): void => {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  bytesOutCounter.inc(bytes);
  bytesOutTotal += bytes;
};

export const recordApiRequest = (statusCode: number): void => {
  const statusClass = `${Math.floor(statusCode / 100)}xx` as keyof typeof apiRequestsByClass;
  if (!(statusClass in apiRequestsByClass)) return;
  apiRequestsCounter.inc({ statusClass });
  apiRequestsByClass[statusClass] += 1;
};

export const recordAdminCacheHit = (): void => {
  adminCacheHitCounter.inc();
  adminCacheHits += 1;
};

export const recordAdminCacheMiss = (): void => {
  adminCacheMissCounter.inc();
  adminCacheMisses += 1;
};

export const getMetricsText = (): Promise<string> => register.metrics();
export const getMetricsContentType = (): string => register.contentType;

/**
 * JSON snapshot of the headline counters for the Server Monitoring REST API —
 * avoids parsing the Prometheus text-exposition format for a handful of
 * numbers the dashboard already needs on every /overview poll.
 */
export const getMetricsSummaryJson = () => {
  const totalCacheLookups = adminCacheHits + adminCacheMisses;

  return {
    connectedSockets,
    messagesSentTotal,
    eventLoopLagMs: Math.round(eventLoopDelay.mean / 1e6),
    bytesInTotal,
    bytesOutTotal,
    // Cumulative since process start — callers wanting a "current" error rate
    // should diff this between two points in time (see
    // serverMonitoringService.ts's rolling apiErrorRatePct), not divide these
    // directly, which would report a lifetime average that a brief early
    // error burst distorts forever.
    apiRequestsByClass: { ...apiRequestsByClass },
    adminCache: {
      hits: adminCacheHits,
      misses: adminCacheMisses,
      hitRatePct: totalCacheLookups > 0 ? (adminCacheHits / totalCacheLookups) * 100 : 0,
    },
  };
};

export const startMetricsLogging = (intervalMs = 60000): NodeJS.Timeout => {
  return setInterval(() => {
    logger.info('Metrics snapshot', {
      connectedSockets,
      eventLoopLagMs: Math.round(eventLoopDelay.mean / 1e6),
    });
  }, intervalMs);
};
