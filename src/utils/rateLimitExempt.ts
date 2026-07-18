import type { Request } from 'express';
import { env } from '../config/env.js';

const LOCAL_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost',
]);

const isLocalIp = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (LOCAL_IPS.has(normalized)) return true;
  return normalized.startsWith('127.');
};

/** Skip API rate limits during local development or when explicitly disabled. */
export const isRateLimitExempt = (req?: Request): boolean => {
  if (process.env.DISABLE_RATE_LIMIT === 'true') return true;
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return true;

  if (!req) return false;

  if (isLocalIp(req.ip)) return true;

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const clientIp = forwarded.split(',')[0]?.trim();
    if (isLocalIp(clientIp)) return true;
  }

  if (isAuthenticatedAdminRequest(req)) return true;

  return false;
};

/**
 * Admin dashboard traffic (billing/RBAC/overview) shares the same public
 * `/api` rate-limit bucket as anonymous requests with no exemption. The
 * dashboard's live WebSocket overview plus independent per-tab fetches
 * (Plans & Pricing, Users & Roles, Purchase Requests each fetch on mount)
 * can exhaust the 100-req/15-min public budget during ordinary use, leaving
 * admin actions silently failing with 429s. The X-Admin-Secret header IS the
 * authorization boundary for these routes (checked again downstream by
 * authenticateAdmin, which still 401s on a missing/wrong secret) — a request
 * that already proves it holds the secret doesn't need public-abuse limits.
 */
const isAuthenticatedAdminRequest = (req: Request): boolean => {
  if (!env.ADMIN_SECRET) return false;
  const header = req.headers['x-admin-secret'];
  const value = Array.isArray(header) ? header[0] : header;
  return value === env.ADMIN_SECRET;
};
