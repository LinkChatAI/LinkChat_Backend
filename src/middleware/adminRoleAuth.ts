import { Request, Response, NextFunction } from 'express';
import { verifyUserAccessToken } from '../utils/userJwt.js';
import { UserModel } from '../models/User.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface AdminUserRequest extends Request {
  adminUser?: {
    userId: string;
    email: string;
    name: string;
  };
}

const extractAccessToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookieToken = req.cookies?.lc_access_token;
  if (typeof cookieToken === 'string') return cookieToken;
  return null;
};

const getPermanentAdminEmails = (): Set<string> => {
  return new Set(
    (env.PERMANENT_ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
};

const SHARED_SECRET_ADMIN_EMAIL = 'dashboard-admin@linkchat.internal';
let sharedSecretAdminId: string | null = null;

/**
 * The dashboard's ADMIN_SECRET gate already sits in front of this whole panel (see
 * AdminRoute.tsx), so re-prompting for a separate Google admin login is redundant friction.
 * This resolves that secret to a real backing User document (created once, cached after)
 * so grantedBy/recordedBy ObjectId refs and the audit trail still have a stable identity.
 */
const getSharedSecretAdminUser = async (): Promise<{ userId: string; email: string; name: string }> => {
  if (!sharedSecretAdminId) {
    const user = await UserModel.findOneAndUpdate(
      { email: SHARED_SECRET_ADMIN_EMAIL },
      {
        $setOnInsert: {
          googleId: 'shared-secret-admin',
          email: SHARED_SECRET_ADMIN_EMAIL,
          name: 'Dashboard Admin',
          plan: 'free',
          role: 'admin',
          status: 'active',
        },
      },
      { upsert: true, new: true }
    );
    sharedSecretAdminId = String(user._id);
  }
  return { userId: sharedSecretAdminId, email: SHARED_SECRET_ADMIN_EMAIL, name: 'Dashboard Admin' };
};

const extractAdminSecret = (req: Request): string | null => {
  const header = req.headers['x-admin-secret'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * RBAC gate for the billing/user-management admin panel. Accepts either the dashboard's
 * shared ADMIN_SECRET (the same one gating AdminRoute.tsx — no extra login needed once
 * inside the dashboard) or a real logged-in user (Google OAuth) whose role is 'admin',
 * checked fresh against the DB on every request so a demotion or ban takes effect
 * immediately. Emails listed in PERMANENT_ADMIN_EMAILS are auto-promoted on first check —
 * a bootstrap path that needs no direct DB access to stand up the first admin account.
 */
export const requireAdminRole = async (
  req: AdminUserRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const adminSecret = extractAdminSecret(req);
  if (adminSecret) {
    if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      req.adminUser = await getSharedSecretAdminUser();
      next();
    } catch (error: unknown) {
      logger.error('Failed to resolve shared-secret admin identity', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to verify admin access' });
    }
    return;
  }

  const token = extractAccessToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  const decoded = verifyUserAccessToken(token);
  if (!decoded) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'AUTH_INVALID' });
    return;
  }

  try {
    const user = await UserModel.findById(decoded.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found', code: 'AUTH_INVALID' });
      return;
    }

    if (user.status !== 'active') {
      res.status(403).json({ error: 'Account is not active', code: 'ACCOUNT_INACTIVE' });
      return;
    }

    let isAdmin = user.role === 'admin';
    if (!isAdmin && getPermanentAdminEmails().has(user.email.toLowerCase())) {
      user.role = 'admin';
      await user.save();
      isAdmin = true;
      logger.info('Auto-promoted permanent admin email to admin role', { email: user.email });
    }

    if (!isAdmin) {
      res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
      return;
    }

    req.adminUser = { userId: String(user._id), email: user.email, name: user.name };
    next();
  } catch (error: unknown) {
    logger.error('requireAdminRole check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to verify admin access' });
  }
};
