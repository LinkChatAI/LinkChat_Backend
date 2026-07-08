// Chat load test — simulates a spike of concurrent participants in one room.
//
//   npm run loadtest
//   LOADTEST_USERS=100 LOADTEST_URL=https://staging.example.com npm run loadtest
//
// Spins up N real socket.io-client connections (same protocol the browser
// uses, unlike a raw-WebSocket tool, which can't speak Engine.IO framing) that
// all join one room — by default at the same instant, to simulate a sudden
// spike rather than a gradual ramp — then send messages at a configured rate
// and measure end-to-end delivery. Each client tracks its own sent messages by
// tempId and confirms delivery via the newMessage echo, so duplicates and
// drops are measured the same way the frontend's own dedup logic sees them.
//
// Env vars:
//   LOADTEST_URL            backend base URL (default http://localhost:8080)
//   LOADTEST_ROOM           room code to join (default: auto-create one via POST /api/rooms)
//   LOADTEST_USERS          concurrent virtual users (default 20)
//   LOADTEST_DURATION_MS    how long clients send messages for (default 20000)
//   LOADTEST_MSG_RATE       messages per second, per user (default 0.5)
//   LOADTEST_JOIN_STAGGER_MS  ms spread between joins; 0 = all-at-once spike (default 0)
//   LOADTEST_TRANSPORT      'websocket' (default, matches prod) or 'polling'

import { io as ioClient } from 'socket.io-client';

const BASE_URL = process.env.LOADTEST_URL || 'http://localhost:8080';
const USERS = parseInt(process.env.LOADTEST_USERS || '20', 10);
const DURATION_MS = parseInt(process.env.LOADTEST_DURATION_MS || '20000', 10);
const MSG_RATE_PER_SEC = parseFloat(process.env.LOADTEST_MSG_RATE || '0.5');
const JOIN_STAGGER_MS = parseInt(process.env.LOADTEST_JOIN_STAGGER_MS || '0', 10);
const TRANSPORT = process.env.LOADTEST_TRANSPORT === 'polling' ? 'polling' : 'websocket';
const GRACE_MS = 5000; // time to wait after DURATION_MS for in-flight broadcasts to land

const percentile = (sortedValues, p) => {
  if (sortedValues.length === 0) return NaN;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[idx];
};

const ensureRoomCode = async () => {
  if (process.env.LOADTEST_ROOM) return process.env.LOADTEST_ROOM;
  const res = await fetch(`${BASE_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`Failed to auto-create a room: HTTP ${res.status} ${await res.text()}`);
  }
  const room = await res.json();
  console.log(`[setup] auto-created room ${room.code}`);
  return room.code;
};

class VirtualUser {
  constructor(index, roomCode) {
    this.index = index;
    this.roomCode = roomCode;
    this.userId = `loadtest-${index}-${Math.random().toString(36).slice(2, 8)}`;
    this.pending = new Map(); // tempId -> sentAt
    this.latenciesMs = [];
    this.duplicates = 0;
    this.sent = 0;
    this.connectError = null;
    this.joinError = null;
    this.joinLatencyMs = null;
    this.seenTempIds = new Set();
  }

  connect() {
    const connectStart = Date.now();
    this.socket = ioClient(BASE_URL, {
      path: '/ws',
      transports: [TRANSPORT],
      reconnection: false,
      timeout: 20000,
      auth: { userId: this.userId, nickname: `Load${this.index}` },
      query: { userId: this.userId },
    });

    this.socket.on('connect_error', (err) => {
      this.connectError = err?.message || String(err);
    });

    this.socket.on('newMessage', (message) => {
      const tempId = message?.tempId;
      if (!tempId || !this.pending.has(tempId)) return;
      if (this.seenTempIds.has(tempId)) {
        this.duplicates++;
        return;
      }
      this.seenTempIds.add(tempId);
      const sentAt = this.pending.get(tempId);
      this.latenciesMs.push(Date.now() - sentAt);
      this.pending.delete(tempId);
    });

    return new Promise((resolve) => {
      this.socket.on('connect', () => {
        const joinStart = Date.now();
        this.socket.emit('joinRoom', { code: this.roomCode, nickname: `Load${this.index}` });
        this.socket.once('roomJoined', () => {
          this.joinLatencyMs = Date.now() - joinStart;
          resolve(true);
        });
        this.socket.once('error', (err) => {
          this.joinError = err?.message || 'join failed';
          resolve(false);
        });
      });
      this.socket.on('connect_error', () => resolve(false));
      // Don't hang the whole run if one client never connects.
      setTimeout(() => resolve(false), 20000 - (Date.now() - connectStart) + 1000);
    });
  }

  startSending(durationMs) {
    if (MSG_RATE_PER_SEC <= 0) return;
    const intervalMs = 1000 / MSG_RATE_PER_SEC;
    this.sendTimer = setInterval(() => {
      const tempId = `${this.userId}-${this.sent}`;
      this.pending.set(tempId, Date.now());
      this.sent++;
      this.socket.emit('sendMessage', { content: `load test message ${this.sent} from ${this.userId}`, tempId });
    }, intervalMs);
    setTimeout(() => clearInterval(this.sendTimer), durationMs);
  }

  disconnect() {
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.socket?.disconnect();
  }
}

const main = async () => {
  console.log(`[config] url=${BASE_URL} users=${USERS} durationMs=${DURATION_MS} msgRate=${MSG_RATE_PER_SEC}/s stagger=${JOIN_STAGGER_MS}ms transport=${TRANSPORT}`);

  const roomCode = await ensureRoomCode();
  const users = Array.from({ length: USERS }, (_, i) => new VirtualUser(i, roomCode));

  console.log(`[run] connecting ${USERS} virtual users to room ${roomCode}${JOIN_STAGGER_MS > 0 ? ' (staggered)' : ' (all at once — simulating a spike)'}...`);
  const connectResults = await Promise.all(
    users.map((u, i) => {
      if (JOIN_STAGGER_MS <= 0) return u.connect();
      return new Promise((resolve) => setTimeout(() => u.connect().then(resolve), i * JOIN_STAGGER_MS));
    }),
  );
  const joined = connectResults.filter(Boolean).length;
  console.log(`[run] ${joined}/${USERS} joined successfully`);

  console.log(`[run] sending messages for ${DURATION_MS}ms...`);
  for (const u of users) {
    if (u.socket?.connected) u.startSending(DURATION_MS);
  }

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS + GRACE_MS));

  const allLatencies = users.flatMap((u) => u.latenciesMs).sort((a, b) => a - b);
  const joinLatencies = users.map((u) => u.joinLatencyMs).filter((v) => v != null).sort((a, b) => a - b);
  const totalSent = users.reduce((sum, u) => sum + u.sent, 0);
  const totalDelivered = allLatencies.length;
  const totalDuplicates = users.reduce((sum, u) => sum + u.duplicates, 0);
  const totalDropped = users.reduce((sum, u) => sum + u.pending.size, 0);
  const connectFailures = users.filter((u) => !u.socket?.connected).length;

  console.log('\n=== RESULTS ===');
  console.log(`connect success: ${joined}/${USERS} (${connectFailures} not connected at end)`);
  console.log(`join latency ms  — p50=${percentile(joinLatencies, 50)} p95=${percentile(joinLatencies, 95)} p99=${percentile(joinLatencies, 99)} max=${joinLatencies.at(-1)}`);
  console.log(`messages sent: ${totalSent}, delivered: ${totalDelivered}, duplicates: ${totalDuplicates}, dropped: ${totalDropped}`);
  console.log(`delivery latency ms — p50=${percentile(allLatencies, 50)} p95=${percentile(allLatencies, 95)} p99=${percentile(allLatencies, 99)} max=${allLatencies.at(-1)}`);
  if (totalDropped > 0) {
    console.log(`WARNING: ${totalDropped} messages never echoed back within ${DURATION_MS + GRACE_MS}ms of being sent.`);
  }
  if (totalDuplicates > 0) {
    console.log(`WARNING: ${totalDuplicates} duplicate deliveries detected.`);
  }

  for (const u of users) u.disconnect();
  process.exit(joined === USERS && totalDropped === 0 && totalDuplicates === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error('[loadtest] fatal error', error);
  process.exit(1);
});
