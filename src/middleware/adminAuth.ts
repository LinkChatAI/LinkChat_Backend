import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import crypto from 'crypto';

export interface AdminRequest extends Request {
  isAdmin?: boolean;
  adminId?: string;
  adminSessionId?: string;
}

// Generate admin ID from secret hash (for tracking)
const generateAdminId = (adminSecret: string): string => {
  return crypto.createHash('sha256').update(adminSecret).digest('hex').substring(0, 16);
};

// Check IP whitelist (optional, set ADMIN_IP_WHITELIST env var)
const isIpWhitelisted = (ip: string): boolean => {
  const whitelist = process.env.ADMIN_IP_WHITELIST;
  if (!whitelist) return true; // No whitelist = allow all
  
  const allowedIps = whitelist.split(',').map(ip => ip.trim());
  return allowedIps.includes(ip) || allowedIps.includes('*');
};

// Session management for admin (optional, for enhanced security)
const validateAdminSession = async (adminId: string, sessionId?: string): Promise<boolean> => {
  if (!sessionId) return true; // Session validation optional
  
  const redis = getRedisClient();
  if (!redis || !isRedisAvailable()) return true;
  
  try {
    const sessionKey = `admin:session:${adminId}:${sessionId}`;
    const exists = await redis.exists(sessionKey);
    return exists === 1;
  } catch {
    return true; // Fail open
  }
};

export const authenticateAdmin = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const adminSecretHeader = req.headers['x-admin-secret'];
  const adminSecretValue = Array.isArray(adminSecretHeader) ? adminSecretHeader[0] : adminSecretHeader;
  const authHeader = req.headers.authorization;
  const adminSecret = adminSecretValue || (typeof authHeader === 'string' ? authHeader.replace('Bearer ', '') : '') || '';
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  
  if (!env.ADMIN_SECRET) {
    logger.error('ADMIN_SECRET not configured');
    res.status(500).json({ error: 'Admin authentication not configured' });
    return;
  }

  // Validate admin secret
  if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
    logger.warn('Unauthorized admin access attempt', { 
      ip: clientIp,
      userAgent: req.get('user-agent'),
      endpoint: req.path,
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Check IP whitelist (if configured)
  if (!isIpWhitelisted(clientIp)) {
    logger.warn('Admin access from non-whitelisted IP', { 
      ip: clientIp,
      endpoint: req.path,
    });
    res.status(403).json({ error: 'Access denied from this IP' });
    return;
  }

  // Generate admin ID for tracking
  const adminId = generateAdminId(adminSecret);
  const sessionId = req.headers['x-admin-session-id'] as string | undefined;

  // Validate session (optional)
  const sessionValid = await validateAdminSession(adminId, sessionId);
  if (!sessionValid && sessionId) {
    logger.warn('Invalid admin session', { 
      adminId,
      ip: clientIp,
    });
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  req.isAdmin = true;
  req.adminId = adminId;
  req.adminSessionId = sessionId;
  
  next();
};

