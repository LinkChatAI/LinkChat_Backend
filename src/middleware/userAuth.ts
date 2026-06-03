import { Request, Response, NextFunction } from 'express';
import { verifyUserAccessToken } from '../utils/userJwt.js';
import { isPremiumPlan } from '../utils/planUtils.js';
import { UserPlan } from '../types/index.js';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  plan: UserPlan;
}

export interface UserAuthRequest extends Request {
  user?: AuthenticatedUser;
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

export const authenticateUser = (
  req: UserAuthRequest,
  res: Response,
  next: NextFunction
): void => {
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

  req.user = { userId: decoded.userId, email: decoded.email, plan: decoded.plan };
  next();
};

export const optionalAuthenticateUser = (
  req: UserAuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const token = extractAccessToken(req);
  if (token) {
    const decoded = verifyUserAccessToken(token);
    if (decoded) {
      req.user = { userId: decoded.userId, email: decoded.email, plan: decoded.plan };
    }
  }
  next();
};

export const requirePremium = (
  req: UserAuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }
  if (!isPremiumPlan(req.user.plan)) {
    res.status(403).json({
      error: 'Premium or Pro subscription required',
      code: 'PREMIUM_REQUIRED',
    });
    return;
  }
  next();
};
