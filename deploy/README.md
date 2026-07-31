# Moving the backend off Cloud Run — what to actually build, and why not a split (yet)

## The finding that changes the plan

The original plan (and the audit's own Section 5) called for splitting the
backend: REST API stays on Cloud Run, Socket.IO moves to a VM. Tracing every
`getIoInstance()` call site before writing any code turned up a real blocker
for that split, specifically:

- `adminController.ts` reads `io.sockets.sockets.size` (live connected-client
  count).
- `adminHandlers.ts` reads `io.sockets.adapter.rooms.get(...)` repeatedly (live
  per-room admin presence).
- Several admin/moderation controllers call `getLiveUserCountsForRooms(io, ...)`
  for live per-room user counts on the admin dashboard.

All of these are **introspection** — "how many sockets are connected right
now" — not broadcast. Socket.IO's Redis *adapter* (already wired in this repo,
`@socket.io/redis-adapter`) supports cross-instance introspection like
`fetchSockets()` because every instance runs a real `Server` that can answer
adapter queries from its peers. A lightweight Redis *emitter*
(`@socket.io/redis-emitter`) — the normal way to let a process that isn't
hosting any sockets still publish into rooms — is explicitly publish-only. It
cannot answer "how many sockets are in this room" from a process with no
sockets in it at all.

Concretely: if the REST API keeps running on Cloud Run with no real Socket.IO
server of its own, and Socket.IO moves entirely to a VM, the admin dashboard's
live user-count and live-connection-count features break (or need a new
internal HTTP endpoint on the VM for the API side to query instead — solvable,
but it's new surface, not a config change).

## What to build instead, for now

**Move the whole backend to the VM — REST and Socket.IO together, exactly as
it runs today — and retire the Cloud Run service for the backend entirely.**
This still fully solves the cost problem the audit identified (Cloud Run no
longer hosts anything, so the WebSocket-connection-duration billing mechanism
goes away completely, not just partially) and it needs zero application code
changes: `getIoInstance()` keeps returning a real, local `Server` because
there's still only one process. Netlify's `/api` proxy target and the
frontend's `VITE_SOCKET_URL` both point at the same VM/domain instead of at
Cloud Run.

At 60–1,000 DAU (see the audit's Section 6), a single small VM handling both
REST and Socket.IO has enormous headroom — this is not a capacity compromise,
it's the simpler, lower-risk version of the same destination.

**Revisit the REST/Socket.IO split later**, once there's an actual reason to
scale the REST API independently (the 1K–10K DAU tier), and pair it with a
small internal endpoint on the Socket.IO side (e.g.
`GET /internal/room-counts?codes=...`) that the API side calls instead of
`getIoInstance()` for the handful of introspection call sites above. That's a
real, bounded piece of work — not something to bolt on blind.

## Files in this directory

- `linkchat-backend.service` — systemd unit. Runs the exact same Docker image
  `cloudbuild.yaml` already builds and pushes (`gcr.io/<project>/linkchat-backend`)
  — no second build pipeline. Update the `IMAGE` env line with your project ID.
- `Caddyfile` — reverse proxy with automatic Let's Encrypt TLS for the
  WebSocket/REST domain. Chosen over a Cloud HTTPS Load Balancer specifically
  because an LB's own forwarding-rule cost (~$18+/month) would eat into the
  savings this migration exists to capture, and a single VM doesn't need a
  load balancer's other benefits (multi-backend routing, global anycast) yet.
- `gce-startup-script.sh` — installs Docker + Caddy and enables both systemd
  services on boot. Idempotent.

## Rough sequence

1. Provision a small VM (`e2-small` is plenty at this scale) in `asia-south1`,
   same VPC as anything else that needs low-latency access (Redis, if you
   self-host it here too per the audit's Finding 2).
2. Point a DNS record (e.g. `ws.linkchat.in`) at its external IP.
3. Copy this `deploy/` directory to the VM (or bake it into a custom image),
   populate `/etc/linkchat-backend.env` with the real secrets (never commit
   these), and run `gce-startup-script.sh` once.
4. Update Netlify's `/api` proxy target and the frontend's `VITE_SOCKET_URL`
   to the new domain. Verify via `curl https://ws.linkchat.in/healthz` and a
   real chat session before cutting traffic over.
5. Once verified, delete the Cloud Run service (`linkroom-backend`) — this is
   what actually removes the ₹2,188 line, not just adds a VM alongside it.
6. Self-host Redis on this same VM per Finding 2, replacing Memorystore.
