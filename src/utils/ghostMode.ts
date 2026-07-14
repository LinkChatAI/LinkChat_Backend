import { Socket } from 'socket.io';
import { env } from '../config/env.js';
import { verifyUserAccessToken } from './userJwt.js';
import { UserModel } from '../models/User.js';
import { logger } from './logger.js';

const getGhostModeEmails = (): Set<string> =>
  new Set(
    (env.GHOST_MODE_ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );

export const isGhostModeEmail = (email: string | null | undefined): boolean =>
  !!email && getGhostModeEmails().has(email.trim().toLowerCase());

/** Extracts one cookie value from a raw `Cookie` header without a cookie-parsing dependency. */
const extractCookie = (cookieHeader: string | undefined, name: string): string | null => {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
};

/**
 * Resolves Super Admin Ghost Mode purely from a server-verified identity: the
 * httpOnly `lc_access_token` session cookie set by the Google OAuth login
 * flow (never readable by client JS, so a client can neither claim nor
 * request this flag). The JWT payload's email is not trusted on its own —
 * we re-fetch the live account from the DB (status + current email) on every
 * connection, matching the re-check-fresh pattern used by requireAdminRole.
 * Any failure (missing/expired/tampered cookie, suspended account, DB error)
 * resolves to false — Ghost Mode fails closed.
 */
export const resolveGhostModeFromSocket = async (socket: Socket): Promise<boolean> => {
  try {
    const token = extractCookie(socket.handshake.headers?.cookie, 'lc_access_token');
    if (!token) return false;

    const decoded = verifyUserAccessToken(token);
    if (!decoded) return false;

    const dbUser = await UserModel.findById(decoded.userId).select('email status').lean();
    if (!dbUser || dbUser.status !== 'active') return false;

    const isGhost = isGhostModeEmail(dbUser.email);
    if (isGhost) {
      logger.info('Super Admin Ghost Mode activated for socket connection', {
        socketId: socket.id,
        email: dbUser.email,
      });
    }
    return isGhost;
  } catch (error: unknown) {
    logger.warn('Ghost mode resolution failed (defaulting to non-ghost)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};
