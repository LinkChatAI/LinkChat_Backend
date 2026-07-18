import crypto from 'crypto';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { logger } from '../utils/logger.js';

/**
 * Bridges a login session across the two domains this app spans:
 * `linkchat.in` (where the primary `lc_access_token` cookie lives, set via
 * the OAuth callback proxied through Netlify — see authController.ts) and
 * the Cloud Run backend's own domain (where the chat Socket.IO connection
 * lands directly, per VITE_SOCKET_URL — see frontend/src/services/socket.ts).
 * A cookie can only ever belong to one domain, so a short-lived, single-use
 * exchange code lets the frontend prove "I'm already logged in on
 * linkchat.in" to the backend's own domain, which then mints an independent
 * copy of the access-token cookie scoped to itself. This is what lets
 * ghost-mode identity resolution (utils/ghostMode.ts, reads the cookie off
 * the socket handshake) see a session at all in production.
 */

const EXCHANGE_TTL_SECONDS = 45;
const keyFor = (code: string) => `session_exchange:${code}`;

// Atomic get-and-delete via Lua rather than GETDEL (Redis >=6.2 only) so this
// works regardless of the deployed Redis version — single use is the whole
// security property here, so the read and the delete must be one atomic op.
const CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

export const createSessionExchangeCode = async (userId: string): Promise<string | null> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return null;
  try {
    const code = crypto.randomBytes(32).toString('base64url');
    await redis.set(keyFor(code), userId, 'EX', EXCHANGE_TTL_SECONDS, 'NX');
    return code;
  } catch (error: unknown) {
    logger.warn('Failed to create session exchange code', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export const consumeSessionExchangeCode = async (code: string): Promise<string | null> => {
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return null;
  try {
    const userId = await redis.eval(CONSUME_SCRIPT, 1, keyFor(code));
    return typeof userId === 'string' && userId ? userId : null;
  } catch (error: unknown) {
    logger.warn('Failed to consume session exchange code', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};
