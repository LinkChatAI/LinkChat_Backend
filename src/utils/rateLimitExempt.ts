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

  return false;
};
