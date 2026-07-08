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

export const recordMessageSent = (): void => {
  messagesSentCounter.inc();
};

export const observeBroadcastLatencyMs = (ms: number): void => {
  broadcastLatencyHistogram.observe(ms);
};

export const getMetricsText = (): Promise<string> => register.metrics();
export const getMetricsContentType = (): string => register.contentType;

export const startMetricsLogging = (intervalMs = 60000): NodeJS.Timeout => {
  return setInterval(() => {
    logger.info('Metrics snapshot', {
      connectedSockets,
      eventLoopLagMs: Math.round(eventLoopDelay.mean / 1e6),
    });
  }, intervalMs);
};
