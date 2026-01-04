import { Request, Response, NextFunction } from 'express';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { logger } from '../utils/logger.js';

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

// Invalidate cache for specific patterns
export const invalidateAdminCache = async (pattern: string): Promise<void> => {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) {
    return;
  }

  try {
    const keys = await redis.keys(`admin:cache:${pattern}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug(`Invalidated ${keys.length} cache keys for pattern: ${pattern}`);
    }
  } catch (error: any) {
    logger.error('Failed to invalidate admin cache', {
      error: error instanceof Error ? error.message : String(error),
      pattern,
    });
  }
};

