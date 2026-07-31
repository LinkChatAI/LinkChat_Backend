// Room cleanup verifier — proves that destroying a room leaves nothing behind.
//
//   npm run verify:cleanup
//   VERIFY_URL=https://staging.example.com npm run verify:cleanup
//
// For each deletion path it: creates a real room, joins it with real
// socket.io-client connections, sends messages, populates the per-room state
// that used to leak (moderation lists, screen-share, nickname reservations),
// then triggers that path and asserts every store is clean.
//
// It checks the stores DIRECTLY (Mongo, Redis, GCS) rather than trusting the
// API's success response — the whole class of bug this guards against is a
// delete that reports success while orphaning resources.
//
// Env vars:
//   VERIFY_URL        backend base URL (default http://localhost:8080)
//   MONGODB_URI       required — direct Mongo assertions
//   REDIS_URL         optional — Redis assertions (skipped if unset)
//   GCS_BUCKET        optional — GCS object assertions (skipped if unset)
//   ADMIN_SECRET      optional — enables the admin-vanish and expiry-sweep paths
//   VERIFY_KEEP       set to 1 to leave rooms behind for manual inspection
//
// Exit code 0 = every path verified clean; 1 = at least one leak found.

import { io as ioClient } from 'socket.io-client';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';

const BASE_URL = process.env.VERIFY_URL || 'http://localhost:8080';
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const REDIS_URL = process.env.REDIS_URL;
const GCS_BUCKET = process.env.GCS_BUCKET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const KEEP = process.env.VERIFY_KEEP === '1';

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI is required — the point of this script is to check the DB directly.');
  process.exit(1);
}

// ─── Store handles ────────────────────────────────────────────────────────────

let db;
let redis;
let bucket;

const connectStores = async () => {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  db = mongoose.connection.db;
  console.log('  mongo:  connected');

  if (REDIS_URL) {
    const { default: Redis } = await import('ioredis');
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    console.log('  redis:  connected');
  } else {
    console.log('  redis:  SKIPPED (REDIS_URL unset) — Redis leaks will NOT be detected');
  }

  if (GCS_BUCKET) {
    const { Storage } = await import('@google-cloud/storage');
    bucket = new Storage().bucket(GCS_BUCKET);
    console.log(`  gcs:    bucket ${GCS_BUCKET}`);
  } else {
    console.log('  gcs:    SKIPPED (GCS_BUCKET unset) — file leaks will NOT be detected');
  }
};

const disconnectStores = async () => {
  await mongoose.disconnect().catch(() => {});
  if (redis) await redis.quit().catch(() => {});
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const createRoom = async (name) => {
  const userId = randomUUID();
  const { status, body } = await api('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, userId }),
  });
  if (status !== 200 && status !== 201) {
    throw new Error(`room creation failed (${status}): ${JSON.stringify(body)}`);
  }
  const room = body.room || body;
  if (!room?.code) throw new Error(`no room code in response: ${JSON.stringify(body)}`);
  return { code: room.code, token: room.token, ownerId: userId };
};

/** Connects a client, joins the room, and resolves once the join is confirmed. */
const joinRoom = (code, { userId = randomUUID(), nickname } = {}) =>
  new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, {
      path: '/ws',
      transports: ['websocket'],
      auth: { userId },
      reconnection: false,
      timeout: 15000,
    });

    const fail = (err) => {
      socket.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => fail(new Error(`join timed out for room ${code}`)), 20000);

    socket.on('connect_error', fail);
    socket.on('error', (e) => console.warn(`    socket error: ${JSON.stringify(e)}`));

    socket.on('joinedRoom', (data) => {
      clearTimeout(timer);
      resolve({ socket, userId, nickname: data?.nickname ?? nickname });
    });
    socket.on('roomJoined', (data) => {
      clearTimeout(timer);
      resolve({ socket, userId, nickname: data?.nickname ?? nickname });
    });

    socket.on('connect', () => {
      socket.emit('joinRoom', { roomId: code, roomCode: code, nickname, userId });
    });
  });

/**
 * Populates the per-room state that historically survived deletion, so a purge
 * that misses any of it produces a visible failure rather than a silent pass.
 */
const populateRoomState = async (code, clients) => {
  const [host, guest] = clients;

  for (const client of clients) {
    client.socket.emit('sendMessage', {
      roomId: code,
      content: `verification message from ${client.userId}`,
      type: 'text',
      tempId: randomUUID(),
    });
  }

  // Screen-share state (roomStates Map) and moderation state (mutedByRoom /
  // kickedByRoom) are created lazily by these events.
  host.socket.emit('screen_share_request', { roomId: code });
  if (guest) {
    host.socket.emit('mute_user', { roomId: code, userId: guest.userId });
  }
  host.socket.emit('typing', { roomId: code });

  await sleep(1500); // let the writes land
};

// ─── Assertions ───────────────────────────────────────────────────────────────

const checkRoomIsGone = async (code) => {
  const leaks = [];

  const room = await db.collection('rooms').findOne({ code });
  if (room) leaks.push(`rooms: document still present (isEnded=${room.isEnded})`);

  const messageCount = await db.collection('messages').countDocuments({ roomCode: code });
  if (messageCount > 0) leaks.push(`messages: ${messageCount} document(s) remain`);

  const bannerCount = await db
    .collection('roombannerassignments')
    .countDocuments({ roomCode: code });
  if (bannerCount > 0) leaks.push(`roomBannerAssignments: ${bannerCount} remain`);

  const savedRefs = await db.collection('users').countDocuments({ 'savedRooms.roomCode': code });
  if (savedRefs > 0) leaks.push(`users.savedRooms: ${savedRefs} stale reference(s)`);

  if (redis) {
    const roomKeys = [`room:${code}:users`, `room:${code}:nicknames`];
    for (const key of roomKeys) {
      const exists = await redis.exists(key);
      if (exists) {
        const ttl = await redis.ttl(key);
        leaks.push(`redis: ${key} still exists (ttl=${ttl})`);
      }
    }
  }

  if (bucket) {
    const [files] = await bucket.getFiles({ prefix: `rooms/${code}/` });
    if (files.length > 0) {
      leaks.push(`gcs: ${files.length} object(s) remain under rooms/${code}/`);
    }
  }

  return leaks;
};

/** All sockets must have been force-disconnected, not merely told to leave. */
const checkSocketsDisconnected = (clients) =>
  clients
    .filter((c) => c.socket.connected)
    .map((c) => `socket for ${c.userId} is still connected`);

// ─── Scenario runner ──────────────────────────────────────────────────────────

const results = [];

const runScenario = async (name, trigger, { skip } = {}) => {
  if (skip) {
    console.log(`\n[SKIP] ${name} — ${skip}`);
    results.push({ name, status: 'skipped', reason: skip });
    return;
  }

  console.log(`\n[RUN ] ${name}`);
  const clients = [];

  try {
    const room = await createRoom(`cleanup-verify ${name}`);
    console.log(`    room ${room.code} created`);

    clients.push(await joinRoom(room.code, { nickname: 'HostUser' }));
    clients.push(await joinRoom(room.code, { nickname: 'GuestUser' }));
    console.log(`    ${clients.length} clients joined`);

    await populateRoomState(room.code, clients);

    // Confirm the state actually exists before deleting — otherwise a passing
    // result could just mean nothing was ever written.
    const preMessages = await db.collection('messages').countDocuments({ roomCode: room.code });
    if (preMessages === 0) {
      throw new Error('precondition failed: no messages were written, cannot verify their deletion');
    }
    console.log(`    precondition ok (${preMessages} messages present)`);

    await trigger(room, clients);
    await sleep(3000); // allow async teardown to settle

    const leaks = [...(await checkRoomIsGone(room.code)), ...checkSocketsDisconnected(clients)];

    if (leaks.length === 0) {
      console.log('    PASS — no residue found');
      results.push({ name, status: 'pass', code: room.code });
    } else {
      console.log('    FAIL — residue found:');
      leaks.forEach((leak) => console.log(`      - ${leak}`));
      results.push({ name, status: 'fail', code: room.code, leaks });
    }
  } catch (error) {
    console.log(`    ERROR — ${error.message}`);
    results.push({ name, status: 'error', reason: error.message });
  } finally {
    if (!KEEP) clients.forEach((c) => c.socket.close());
  }
};

// ─── Scenarios ────────────────────────────────────────────────────────────────

const main = async () => {
  console.log(`Room cleanup verification against ${BASE_URL}\n`);
  await connectStores();

  await runScenario('socket: admin_end_room (owner vanish)', async (room, clients) => {
    clients[0].socket.emit('admin_end_room', { roomId: room.code });
  });

  await runScenario('socket: destroy_room (host ends meeting)', async (room, clients) => {
    clients[0].socket.emit('destroy_room', { roomId: room.code, roomToken: room.token });
  });

  await runScenario('socket: admin_close_room (legacy)', async (room, clients) => {
    clients[0].socket.emit('admin_close_room', { roomToken: room.token });
  });

  await runScenario('REST: DELETE /api/rooms/:code', async (room) => {
    const { status, body } = await api(`/api/rooms/${room.code}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${room.token}` },
    });
    if (status !== 200) throw new Error(`delete failed (${status}): ${JSON.stringify(body)}`);
  });

  // Regression guards for the auth hole this work closed. Inverted assertions:
  // here a SURVIVING room is the pass condition.
  //
  // Two distinct attacks are covered — no credentials at all, and a valid
  // token for a different room (the middleware verifies the signature but not
  // that the token's roomCode claim matches the room being deleted).
  const authzCases = [
    { label: 'no credentials', expect: 401, headers: {} },
    { label: 'token for another room', expect: 403, headers: null }, // filled in below
  ];

  console.log('\n[RUN ] REST: DELETE authorization');
  try {
    const victim = await createRoom('cleanup-verify authz victim');
    const attacker = await createRoom('cleanup-verify authz attacker');
    authzCases[1].headers = { Authorization: `Bearer ${attacker.token}` };

    let allRejected = true;
    const failures = [];

    for (const testCase of authzCases) {
      const { status } = await api(`/api/rooms/${victim.code}`, {
        method: 'DELETE',
        headers: testCase.headers,
      });
      const stillThere = await db.collection('rooms').findOne({ code: victim.code });

      if (status === testCase.expect && stillThere) {
        console.log(`    ok   ${testCase.label} -> ${status}, room intact`);
      } else {
        allRejected = false;
        failures.push(
          `${testCase.label}: got ${status} (expected ${testCase.expect}); room ${stillThere ? 'survived' : 'WAS DESTROYED'}`,
        );
        console.log(`    FAIL ${testCase.label} -> ${status}`);
      }
    }

    results.push(
      allRejected
        ? { name: 'REST delete authz', status: 'pass' }
        : { name: 'REST delete authz', status: 'fail', leaks: failures },
    );

    for (const room of [victim, attacker]) {
      await api(`/api/rooms/${room.code}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${room.token}` },
      });
    }
  } catch (error) {
    console.log(`    ERROR — ${error.message}`);
    results.push({ name: 'REST delete authz', status: 'error', reason: error.message });
  }

  await runScenario(
    'sweep: expired room cleanup',
    async (room) => {
      // Force expiry, then trigger the sweep the way Cloud Scheduler does.
      await db
        .collection('rooms')
        .updateOne({ code: room.code }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });

      const { status, body } = await api('/api/admin/maintenance/run?job=cleanup', {
        method: 'POST',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      });
      if (status !== 200) throw new Error(`sweep failed (${status}): ${JSON.stringify(body)}`);
    },
    { skip: ADMIN_SECRET ? undefined : 'ADMIN_SECRET unset' },
  );

  await runScenario(
    'admin: vanish room',
    async (room) => {
      const { status, body } = await api(`/api/admin/rooms/${room.code}/vanish`, {
        method: 'POST',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      });
      if (status !== 200) throw new Error(`vanish failed (${status}): ${JSON.stringify(body)}`);
    },
    { skip: ADMIN_SECRET ? undefined : 'ADMIN_SECRET unset' },
  );

  // ─── Report ─────────────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(70));
  console.log('SUMMARY');
  console.log('─'.repeat(70));

  for (const r of results) {
    const label = r.status.toUpperCase().padEnd(7);
    console.log(`  ${label} ${r.name}${r.reason ? ` (${r.reason})` : ''}`);
    if (r.leaks) r.leaks.forEach((leak) => console.log(`          - ${leak}`));
  }

  const failed = results.filter((r) => r.status === 'fail' || r.status === 'error');
  const skipped = results.filter((r) => r.status === 'skipped');

  if (!redis || !bucket) {
    console.log(
      `\n  NOTE: coverage is partial — ${!redis ? 'Redis ' : ''}${!bucket ? 'GCS ' : ''}` +
        'assertions were skipped. A pass here does not prove those stores are clean.',
    );
  }
  if (skipped.length > 0) {
    console.log(`\n  ${skipped.length} scenario(s) skipped.`);
  }

  await disconnectStores();

  if (failed.length > 0) {
    console.log(`\nRESULT: ${failed.length} scenario(s) failed.\n`);
    process.exit(1);
  }
  console.log('\nRESULT: all verified scenarios left no residue.\n');
  process.exit(0);
};

main().catch(async (error) => {
  console.error('\nVerifier crashed:', error);
  await disconnectStores();
  process.exit(1);
});
