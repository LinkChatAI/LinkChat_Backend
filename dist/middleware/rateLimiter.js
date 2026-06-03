import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { logger } from '../utils/logger.js';
const RATE_LIMITS = {
    createRoom: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 5, // 5 rooms per minute
    },
    getRoom: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 30, // 30 requests per minute
    },
    uploadUrl: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 20, // 20 upload URLs per minute
    },
    adminDashboard: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 30, // 30 dashboard requests per minute
    },
    adminInsight: {
        windowMs: 10 * 1000, // 10 seconds
        maxRequests: 10, // 10 insight requests per 10 seconds
    },
    adminAction: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 10, // 10 action requests per minute
    },
    contactSubmit: {
        windowMs: 60 * 60 * 1000, // 1 hour
        maxRequests: 5, // 5 submissions per hour per IP (additional email-based limit in controller)
    },
    default: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 10, // 10 requests per minute
    },
};
export const rateLimiter = (type = 'default') => {
    return async (req, res, next) => {
        const config = RATE_LIMITS[type] || RATE_LIMITS.default;
        const redis = getRedisClient();
        // If Redis is not available, skip rate limiting (fail open)
        if (!redis || !isRedisAvailable()) {
            next();
            return;
        }
        // For admin routes, use admin ID if available, otherwise IP
        const adminId = req.adminId;
        const identifier = adminId || req.ip || 'unknown';
        // Generate key based on identifier and endpoint type
        const key = `rate_limit:${type}:${identifier}`;
        try {
            const count = await redis.incr(key);
            if (count === 1) {
                await redis.expire(key, Math.ceil(config.windowMs / 1000));
            }
            if (count > config.maxRequests) {
                res.status(429).json({
                    error: 'Too many requests',
                    retryAfter: Math.ceil(config.windowMs / 1000)
                });
                return;
            }
            // Add rate limit headers
            res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
            res.setHeader('X-RateLimit-Remaining', Math.max(0, config.maxRequests - count).toString());
            res.setHeader('X-RateLimit-Reset', new Date(Date.now() + config.windowMs).toISOString());
            next();
        }
        catch (error) {
            logger.error('Rate limiter error', { error: error instanceof Error ? error.message : String(error) });
            // Fail open - allow request if Redis is down
            next();
        }
    };
};
// Socket rate limiting helper
export const socketRateLimiter = async (socketId, eventType, maxRequests = 10, windowMs = 60000) => {
    const redis = getRedisClient();
    // If Redis is not available, allow the request (fail open)
    if (!redis || !isRedisAvailable()) {
        return true;
    }
    const key = `socket_rate_limit:${eventType}:${socketId}`;
    try {
        const count = await redis.incr(key);
        if (count === 1) {
            await redis.expire(key, Math.ceil(windowMs / 1000));
        }
        return count <= maxRequests;
    }
    catch (error) {
        logger.error('Socket rate limiter error', { error: error instanceof Error ? error.message : String(error) });
        return true; // Fail open
    }
};
//# sourceMappingURL=rateLimiter.js.map