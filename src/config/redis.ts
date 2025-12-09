import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { env } from './env';

let redisClient: Redis | null = null;
let redisAvailable = false;

export const getRedisClient = (): Redis | null => {
  if (!redisClient) {
    try {
      redisClient = new Redis(env.REDIS_URL, {
        retryStrategy: (times) => {
          // Retry with exponential backoff, max 10 seconds
          const delay = Math.min(times * 50, 10000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      
      redisClient.on('error', (err) => {
        redisAvailable = false;
        // Suppress connection errors - Redis is optional
        // Only log non-connection errors
        if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOTFOUND' && err.code !== 'ETIMEDOUT') {
          logger.error('Redis error', { error: err });
        }
      });
      
      redisClient.on('connect', () => {
        redisAvailable = true;
        logger.info('Connected to Redis');
      });
      
      redisClient.on('ready', () => {
        redisAvailable = true;
      });
      
      redisClient.on('close', () => {
        redisAvailable = false;
      });
      
      // Try to connect, but don't fail if it doesn't work
      redisClient.connect().catch(() => {
        // Silently fail - Redis is optional
        redisAvailable = false;
      });
    } catch (error) {
      logger.warn('Redis initialization failed, continuing without Redis', { error });
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
    } catch (error) {
      // Ignore errors on close
      redisClient = null;
      redisAvailable = false;
    }
  }
};

