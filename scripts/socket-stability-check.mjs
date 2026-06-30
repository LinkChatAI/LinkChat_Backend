// Socket.IO connection-stability check.
//
//   npm run check:socket
//
// Starts a Socket.IO server with the SAME options as src/index.ts and connects
// two real clients:
//   1. production config  — websocket-only on /ws (no polling session cycle)
//   2. development config — polling first, then upgrade to websocket
//
// A stable result is: 2 connects, 0 unexpected disconnects, both round-trips OK.
// This guards against regressions in transport / path / option changes that
// previously caused the "transport close" reconnect loop and the HTTP 400
// "Session ID unknown" storm.

import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

const PORT = 8099;
const OBSERVE_MS = 8000;

const httpServer = createServer();
const io = new Server(httpServer, {
  path: '/ws',
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 90000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 15 * 1024 * 1024,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

io.on('connection', (socket) => {
  console.log(`[server] connected ${socket.id} (recovered=${socket.recovered})`);
  socket.on('disconnect', (reason) => console.log(`[server] disconnected ${socket.id} reason=${reason}`));
  socket.on('ping_test', (cb) => cb && cb('pong'));
});

let connects = 0;
let disconnects = 0;
const reasons = [];

await new Promise((res) => httpServer.listen(PORT, res));
console.log(`[server] listening on :${PORT}/ws\n`);

function makeClient(label, transports, upgrade) {
  const socket = ioClient(`http://localhost:${PORT}`, {
    path: '/ws',
    transports,
    upgrade,
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    reconnectionAttempts: Infinity,
    timeout: 30000,
    forceNew: true,
    auth: { userId: 'test-user', nickname: 'Tester' },
    query: { userId: 'test-user' },
  });
  socket.on('connect', () => {
    connects++;
    console.log(`[${label}] connected (transport: ${socket.io.engine.transport.name})`);
    socket.io.engine.on('upgrade', (t) => console.log(`[${label}] upgraded to: ${t.name}`));
    socket.emit('ping_test', (resp) => console.log(`[${label}] ping_test -> ${resp}`));
  });
  socket.on('disconnect', (reason) => {
    disconnects++;
    reasons.push(reason);
    console.log(`[${label}] disconnected: ${reason}`);
  });
  socket.on('connect_error', (err) =>
    console.log(`[${label}] connect_error: ${err.message} (status=${err.description?.status ?? 'n/a'})`));
  return socket;
}

console.log('=== production config (websocket-only) ===');
const prodClient = makeClient('prod-ws', ['websocket'], false);
console.log('=== development config (polling -> upgrade) ===');
const devClient = makeClient('dev-poll', ['polling', 'websocket'], true);

await new Promise((res) => setTimeout(res, OBSERVE_MS));

console.log('\n=== RESULTS ===');
console.log(`connects=${connects} disconnects=${disconnects} reasons=${JSON.stringify(reasons)}`);
const stable = connects === 2 && disconnects === 0;
console.log(`STABLE: ${stable ? 'YES' : 'NO'}`);

prodClient.close();
devClient.close();
io.close();
httpServer.close();
process.exit(stable ? 0 : 1);
