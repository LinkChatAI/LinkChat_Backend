import { Request, Response, NextFunction } from 'express';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { recordAdminCacheHit, recordAdminCacheMiss } from '../services/metricsService.js';

const getRedis = () => getRedisClient();

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  keyGenerator?: (req: Request) => string;
  skipCache?: (req: Request) => boolean;
}

const DEFAULT_TTL = 30; // 30 seconds default cache

export const cacheAdminResponse = (options: CacheOptions = {}) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const redis = getRedis();
    
    // Skip caching if Redis not available
    if (!redis || !isRedisAvailable()) {
      next();
      return;
    }

    // Check if cache should be skipped
    if (options.skipCache && options.skipCache(req)) {
      next();
      return;
    }

    const ttl = options.ttl || DEFAULT_TTL;
    const keyGenerator = options.keyGenerator || ((req: Request) => {
      return `admin:cache:${req.path}:${JSON.stringify(req.query)}`;
    });

    const cacheKey = keyGenerator(req);

    try {
      // Try to get from cache
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        recordAdminCacheHit();
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        res.json(data);
        return;
      }

      // Cache miss - override res.json to cache response
      const originalJson = res.json.bind(res);
      res.json = function (body: any) {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          redis.setex(cacheKey, ttl, JSON.stringify(body)).catch((error: any) => {
            logger.warn('Failed to cache admin response', {
              error: error instanceof Error ? error.message : String(error),
              cacheKey,
            });
          });
        }
        recordAdminCacheMiss();
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Cache-Key', cacheKey);
        return originalJson(body);
      };

      next();
    } catch (error: any) {
      logger.error('Cache middleware error', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fail open - continue without cache
      next();
    }
  };
};

// The dashboard-affecting cache keys, exactly as cacheAdminResponse's
// default keyGenerator produces them (`admin:cache:${req.path}:${query}`,
// where req.path is router-relative — always starts with '/' since Express
// strips the /api/admin mount prefix — and query is '{}' since none of
// these three routes accept query params today). Kept as an exact list and
// `redis.del()`'d directly rather than pattern-matched with `KEYS`/`SCAN`:
// the previous glob-based `invalidateAdminCache(pattern)` searched
// `admin:cache:${pattern}*`, which could never match a real key like
// `admin:cache:/insights/dashboard:{}` (the pattern expected `i` right
// where the real key has `/`) — it had never actually invalidated anything;
// the cache only ever expired via TTL. If any of these routes gain a query
// parameter in the future, this list needs updating to match.
const DASHBOARD_CACHE_KEYS = [
  'admin:cache:/insights/dashboard:{}',
  'admin:cache:/rooms/active:{}',
  'admin:cache:/rooms/locked:{}',
] as const;

export const invalidateDashboardCache = async (): Promise<void> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) {
    return;
  }

  try {
    await redis.del(...DASHBOARD_CACHE_KEYS);
    logger.debug('Invalidated admin dashboard cache keys');
  } catch (error: any) {
    logger.error('Failed to invalidate admin dashboard cache', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

