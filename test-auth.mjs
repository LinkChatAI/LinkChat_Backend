/**
 * Quick auth smoke test — run: node test-auth.mjs
 * Requires backend on PORT from .env (default 8081)
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 8081;
const BASE = `http://localhost:${PORT}`;

const tests = [];

async function check(name, fn) {
  try {
    await fn();
    tests.push({ name, ok: true });
    console.log(`✅ ${name}`);
  } catch (err) {
    tests.push({ name, ok: false, error: err.message });
    console.log(`❌ ${name}: ${err.message}`);
  }
}

await check("GET /api/auth/status → oauthConfigured", async () => {
  const res = await fetch(`${BASE}/api/auth/status`);
  const data = await res.json();
  if (!res.ok || !data.oauthConfigured) throw new Error(JSON.stringify(data));
});

await check("GET /api/auth/me without cookie → 401", async () => {
  const res = await fetch(`${BASE}/api/auth/me`);
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check("GET /api/auth/google → 302 to Google", async () => {
  const res = await fetch(`${BASE}/api/auth/google?returnTo=/`, {
    redirect: "manual",
  });
  if (res.status !== 302) throw new Error(`expected 302, got ${res.status}`);
  const loc = res.headers.get("location") || "";
  if (!loc.includes("accounts.google.com"))
    throw new Error(`unexpected redirect: ${loc.slice(0, 80)}`);
});

await check("POST /api/auth/refresh without cookie → 401", async () => {
  const res = await fetch(`${BASE}/api/auth/refresh`, { method: "POST" });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check("GET /api/user/rooms/saved without auth → 401", async () => {
  const res = await fetch(`${BASE}/api/user/rooms/saved`);
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check("POST /api/rooms plan=premium without auth → 401", async () => {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "premium" }),
  });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

await check("POST /api/rooms plan=free without auth → 200", async () => {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Auth Test Room" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `status ${res.status}`);
  }
});

const passed = tests.filter((t) => t.ok).length;
console.log(`\n${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
