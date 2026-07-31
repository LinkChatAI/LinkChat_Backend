# Room data lifecycle and cleanup

How a room's data is destroyed, and what to run when deploying this.

## The single teardown path

`services/roomPurgeService.ts` → `purgeRoom(roomCode, options)` is the only
place that destroys a room. Every trigger routes through it:

| Trigger | Entry point |
| --- | --- |
| Room expired | `cleanupService.cleanupExpiredRooms` |
| Host ended the room (deferred) | `cleanupService.cleanupEndedRooms` |
| Locked room hit its auto-vanish window | `autoVanishService.processAutoVanish` |
| Host left and didn't return | `roomLifecycleHandlers.destroyRoomAfterGracePeriod` |
| Owner vanished the room | socket `admin_end_room` |
| Host ended the meeting | socket `destroy_room` |
| Legacy host close | socket `admin_close_room` |
| Platform admin vanish | `adminRoomService.adminVanishRoom` |
| REST delete | `DELETE /api/rooms/:code` |

Before this consolidation each of these had its own cleanup code clearing a
different subset of state. If you add a new way to delete a room, call
`purgeRoom` — do not write a new teardown.

### What a purge removes

- **Mongo** — `Room`, all `Message` docs, `RoomBannerAssignment`, and stale
  `savedRooms` references on `User`
- **Files** — GCS objects under `rooms/{code}/` **and** the local
  `uploads/rooms/{code}/` directory, always both (uploads fall back to local
  disk during a GCS outage, so a room can have bytes in either place)
- **Redis** — `room:{code}:users`, `room:{code}:nicknames`, and each
  `user:{userId}` hash that still points at this room
- **Sockets** — every participant is notified, removed from the room, and
  force-disconnected
- **In-memory** — room cache, socket cache, screen-share state, mute/kick
  lists, slow-mode counters, read receipts, pending timers, and the room's
  Prometheus gauge series. Cleared on **every** instance via a `room:purged`
  fan-out over the Redis adapter, since these are per-process.

### What a purge deliberately keeps

- **`UserVisit` rows** — these back lifetime analytics (unique users, 7/30-day
  retention, session duration, the geo map). Deleting them per-room would
  permanently skew those dashboards. Set
  `PURGE_USER_VISITS_ON_ROOM_DELETE=true` to purge them anyway.
- **Sponsor banner assets** — reusable library items that may be assigned to
  other rooms. Only this room's *assignment* is removed.
- **`AdminAction` audit rows** — an audit log that survives its subject is the
  point of an audit log.

## Deploying this: required migration

**The code change alone does not take effect until you drop the old index.**

`Room.expiresAt` previously carried a TTL index (`expireAfterSeconds: 0`). A
TTL index makes mongod delete the document itself, running no application code
— so files, Redis keys, in-memory state and live sockets were all orphaned.
Mongo's TTL monitor sweeps every 60s and always beat the cleanup job, so in
practice expired rooms were *never* properly cleaned up.

Mongoose creates indexes but never drops existing ones, so removing
`expireAfterSeconds` from the schema does nothing to a live database.

```bash
MONGODB_URI="<uri>" node scripts/drop-room-ttl-index.mjs
```

Dry run by default. Add `--apply` to actually drop it:

```bash
MONGODB_URI="<uri>" node scripts/drop-room-ttl-index.mjs --apply
```

Then clear the backlog that the old behaviour already orphaned:

```bash
curl -X POST -H "x-admin-secret: $ADMIN_SECRET" \
  "$BASE_URL/api/admin/maintenance/run?job=reconcile-orphans"
```

Re-run that until it reports `truncated: false` — it is capped per run.

## Scheduling

Expiry cleanup is now the **only** thing that deletes expired rooms. It must
stay scheduled.

- `ENABLE_IN_PROCESS_TIMERS=true` (default): runs in-process every
  `CLEANUP_INTERVAL_MS` (default 5 min).
- `ENABLE_IN_PROCESS_TIMERS=false`: you **must** point Cloud Scheduler at
  `POST /api/admin/maintenance/run` — a bare `setInterval` stalls on a
  scale-to-zero instance.

Recommended cadences:

| Job | Cadence |
| --- | --- |
| `cleanup`, `auto-vanish`, `subscription-expiry` (the no-`job` default) | every 5 min |
| `orphaned-uploads` | daily |
| `reconcile-orphans` | daily |

## Verifying

```bash
MONGODB_URI="<uri>" REDIS_URL="<url>" GCS_BUCKET="<bucket>" \
ADMIN_SECRET="<secret>" VERIFY_URL="https://<host>" \
npm run verify:cleanup
```

For each deletion path this creates a real room, joins it with real socket
clients, sends messages, populates the state that used to leak, triggers that
path, then asserts Mongo/Redis/GCS are clean and every socket was
disconnected. It checks the stores directly rather than trusting the API
response — the bug class it guards against is a delete that reports success
while orphaning resources.

Exits non-zero if anything survives. `REDIS_URL` and `GCS_BUCKET` are optional
but coverage is partial without them, and the script says so in its summary.

## Tuning

| Env var | Default | Effect |
| --- | --- | --- |
| `CLEANUP_INTERVAL_MS` | `300000` (5 min) | Upper bound on how long expired data survives |
| `CLEANUP_BATCH_SIZE` | `200` | Rooms purged per tick |
| `ENDED_ROOM_GRACE_MS` | `3600000` (1 h) | Recovery window after a host ends a room |
| `RECONCILE_MAX_CODES` | `500` | Room codes examined per reconciliation run |
| `PURGE_USER_VISITS_ON_ROOM_DELETE` | `false` | Also delete UserVisit rows (see above) |

## Notes for future changes

- **Never re-add `expireAfterSeconds` to `Room.expiresAt`.** It silently
  disables all room file/Redis/memory cleanup.
- Room codes are recycled from a small space (370 values with the default
  4-digit patterned format). Any state keyed by room code that outlives its
  room will be inherited by a different room later — this is why the purge
  clears mute/kick lists and screen-share state, not just for memory.
- If you add a new per-room `Map`/`Set`/gauge, add its clear function to
  `clearInMemoryRoomState` in `roomPurgeService.ts`.
