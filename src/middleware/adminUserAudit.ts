import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AdminUserRequest } from './adminRoleAuth.js';
import { AdminActionModel } from '../models/AdminAction.js';
import { logger } from '../utils/logger.js';

/**
 * Audit logging for the per-user RBAC admin panel — mirrors `adminAudit.ts`'s shape/behavior
 * (same AdminAction collection) but records the real admin's identity (from `requireAdminRole`)
 * instead of a hash of the shared secret, so every action is attributable to a named account.
 */
export const auditAdminUserAction = (
  action: string,
  metadata?: Record<string, unknown>
) => {
  return (req: AdminUserRequest, res: Response, next: NextFunction): void => {
    const startTime = Date.now();
    const requestId = uuidv4();

    const writeLog = (success: boolean, body?: unknown) => {
      const responseTime = Date.now() - startTime;
      AdminActionModel.create({
        adminId: req.adminUser?.userId || 'unknown',
        adminEmail: req.adminUser?.email,
        action,
        endpoint: req.path,
        method: req.method,
        ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
        userAgent: req.get('user-agent'),
        requestId,
        success,
        errorMessage: !success ? ((body as { error?: string })?.error || 'Unknown error') : undefined,
        responseTime,
        metadata: { ...metadata, statusCode: res.statusCode },
      }).catch((error: unknown) => {
        logger.error('Failed to log admin user action', {
          error: error instanceof Error ? error.message : String(error),
          requestId,
        });
      });
    };

    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      writeLog(res.statusCode < 400, body);
      return originalJson(body);
    };

    next();
  };
};
