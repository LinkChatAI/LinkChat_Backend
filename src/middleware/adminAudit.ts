import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from './adminAuth.js';
import { AdminActionModel } from '../models/AdminAction.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

// Generate admin ID from secret hash (for tracking without exposing secret)
const generateAdminId = (adminSecret: string): string => {
  // Simple hash for admin ID (not for security, just for tracking)
  // In production, use a proper hash function
  return Buffer.from(adminSecret).toString('base64').substring(0, 16);
};

export const auditAdminAction = (
  action: string,
  metadata?: Record<string, any>
) => {
  return async (req: AdminRequest, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();
    const requestId = uuidv4();
    const adminSecretHeader = req.headers['x-admin-secret'];
    const adminSecretValue = Array.isArray(adminSecretHeader) ? adminSecretHeader[0] : adminSecretHeader;
    const authHeader = req.headers.authorization;
    const adminSecret = adminSecretValue || (typeof authHeader === 'string' ? authHeader.replace('Bearer ', '') : '') || '';
    const adminId = adminSecret ? generateAdminId(adminSecret) : 'unknown';

    // Store request ID for error handling
    (req as any).requestId = requestId;
    (req as any).adminId = adminId;

    // Override res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
      const responseTime = Date.now() - startTime;
      
      // Log audit asynchronously (don't block response)
      AdminActionModel.create({
        adminId,
        action,
        endpoint: req.path,
        method: req.method,
        ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
        userAgent: req.get('user-agent'),
        requestId,
        success: res.statusCode < 400,
        errorMessage: res.statusCode >= 400 ? (body?.error || 'Unknown error') : undefined,
        responseTime,
        metadata: {
          ...metadata,
          statusCode: res.statusCode,
        },
      }).catch((error) => {
        logger.error('Failed to log admin action', {
          error: error instanceof Error ? error.message : String(error),
          requestId,
        });
      });

      return originalJson(body);
    };

    // Handle errors
    const originalEnd = res.end.bind(res);
    res.end = function (chunk?: any) {
      if (res.statusCode >= 400) {
        const responseTime = Date.now() - startTime;
        AdminActionModel.create({
          adminId,
          action,
          endpoint: req.path,
          method: req.method,
          ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
          userAgent: req.get('user-agent'),
          requestId,
          success: false,
          errorMessage: 'Request failed',
          responseTime,
          metadata: {
            ...metadata,
            statusCode: res.statusCode,
          },
        }).catch((error) => {
          logger.error('Failed to log admin action error', {
            error: error instanceof Error ? error.message : String(error),
            requestId,
          });
        });
      }
      return originalEnd(chunk);
    };

    next();
  };
};

