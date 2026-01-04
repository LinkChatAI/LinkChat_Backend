import { default as Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import { env } from './env.js';

let redisClient: any = null;
let redisAvailable = false;

export const getRedisClient = (): any => {
  if (!env.REDIS_URL) {
    return null;
  }

  if (!redisClient) {
    try {
      const RedisClass = Redis as any;
      const client = new RedisClass(env.REDIS_URL, {
        retryStrategy: (times: number) => {
          // Retry with exponential backoff, max 10 seconds
          const delay = Math.min(times * 50, 10000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      
      redisClient = client;
      
      client.on('error', (err: any) => {
        redisAvailable = false;
        // Suppress connection errors - Redis is optional
        // Only log non-connection errors
        const nodeError = err as NodeJS.ErrnoException;
        if (nodeError.code !== 'ECONNREFUSED' && nodeError.code !== 'ENOTFOUND' && nodeError.code !== 'ETIMEDOUT') {
          logger.error('Redis error', { error: err instanceof Error ? err.message : String(err) });
        }
      });
      
      client.on('connect', () => {
        redisAvailable = true;
        logger.info('Connected to Redis');
      });
      
      client.on('ready', () => {
        redisAvailable = true;
      });
      
      client.on('close', () => {
        redisAvailable = false;
      });
      
      // Try to connect, but don't fail if it doesn't work
      client.connect().catch(() => {
        // Silently fail - Redis is optional
        redisAvailable = false;
      });
    } catch (error: any) {
      logger.warn('Redis initialization failed, continuing without Redis', { error: error instanceof Error ? error.message : String(error) });
      redisAvailable = false;
    }
  }
  return redisClient;
};

export const isRedisAvailable = (): boolean => {
  return redisAvailable && redisClient?.status === 'ready';
};

export const closeRedis = async (): Promise<void> => {
  if (redisClient) {
    try {
      await redisClient.quit();
      redisClient = null;
      redisAvailable = false;
      logger.info('Redis connection closed');
    } catch (error: any) {
      // Ignore errors on close
      redisClient = null;
      redisAvailable = false;
    }
  }
};

