import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';

/**
 * Approximate, city-level location derived from a public IP address.
 * Never derived from browser GPS — precision is intentionally coarse (city/region).
 */
export interface GeoIpResult {
  ip: string;
  city?: string;
  region?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REDIS_CACHE_TTL_S = 7 * 24 * 60 * 60;
const MAX_CACHE_SIZE = 2000;
const geoCache = new Map<string, { data: GeoIpResult | null; expiresAt: number }>();

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

/** Local/private/loopback addresses can't be geolocated — skip the lookup entirely. */
export function isPrivateOrLocalIp(ip: string | undefined): boolean {
  if (!ip || ip === 'unknown') return true;
  const normalized = ip.replace('::ffff:', '');
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function getCached(ip: string): Promise<GeoIpResult | null | undefined> {
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      const raw = await redis.get(`geoip:${ip}`);
      if (raw === null) return undefined; // not cached
      if (raw === '') return null; // negative cache hit
      return JSON.parse(raw) as GeoIpResult;
    } catch {
      // fall through to in-memory cache
    }
  }
  const entry = geoCache.get(ip);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    geoCache.delete(ip);
    return undefined;
  }
  return entry.data;
}

async function setCache(ip: string, data: GeoIpResult | null): Promise<void> {
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      const value = data === null ? '' : JSON.stringify(data);
      await redis.set(`geoip:${ip}`, value, 'EX', REDIS_CACHE_TTL_S);
    } catch {
      // non-fatal, fall through to in-memory cache
    }
  }
  if (geoCache.size >= MAX_CACHE_SIZE) {
    const firstKey = geoCache.keys().next().value;
    if (firstKey) geoCache.delete(firstKey);
  }
  geoCache.set(ip, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolve an approximate city/region/country for a public IP using ip-api.com's
 * free endpoint. Returns null for private/local IPs or on any lookup failure —
 * geolocation is best-effort and must never block the caller's main flow.
 */
export async function resolveGeoIp(ip: string): Promise<GeoIpResult | null> {
  if (isPrivateOrLocalIp(ip)) return null;

  const cached = await getCached(ip);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,lat,lon,query`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      await setCache(ip, null);
      return null;
    }

    const json = (await response.json()) as {
      status?: string;
      city?: unknown;
      regionName?: unknown;
      country?: unknown;
      lat?: unknown;
      lon?: unknown;
    };
    if (json.status !== 'success') {
      await setCache(ip, null);
      return null;
    }

    const result: GeoIpResult = {
      ip,
      city: typeof json.city === 'string' ? json.city : undefined,
      region: typeof json.regionName === 'string' ? json.regionName : undefined,
      country: typeof json.country === 'string' ? json.country : undefined,
      lat: typeof json.lat === 'number' ? json.lat : undefined,
      lon: typeof json.lon === 'number' ? json.lon : undefined,
    };

    await setCache(ip, result);
    return result;
  } catch (error) {
    clearTimeout(timeout);
    logger.warn('GeoIP lookup failed', {
      error: error instanceof Error ? error.message : String(error),
      ip,
    });
    return null;
  }
}
