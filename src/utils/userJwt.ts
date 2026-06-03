import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { UserPlan } from '../types/index.js';

export interface UserAccessPayload {
  type: 'user_access';
  userId: string;
  email: string;
  plan: UserPlan;
}

export interface UserRefreshPayload {
  type: 'user_refresh';
  userId: string;
  jti: string;
}

const ACCESS_EXPIRY = '15m';
const REFRESH_EXPIRY = '7d';

const getSecret = (): string => {
  const secret = env.USER_JWT_SECRET || env.JWT_SECRET;
  if (!secret || secret === 'default-secret-change-in-production') {
    logger.warn('JWT secret is using default value. Change in production.');
  }
  return secret;
};

export const generateUserAccessToken = (
  userId: string,
  email: string,
  plan: UserPlan
): string => {
  const payload: UserAccessPayload = { type: 'user_access', userId, email, plan };
  return jwt.sign(payload, getSecret(), { expiresIn: ACCESS_EXPIRY });
};

export const generateUserRefreshToken = (userId: string): { token: string; jti: string } => {
  const jti = crypto.randomUUID();
  const payload: UserRefreshPayload = { type: 'user_refresh', userId, jti };
  const token = jwt.sign(payload, getSecret(), { expiresIn: REFRESH_EXPIRY });
  return { token, jti };
};

export const verifyUserAccessToken = (token: string): UserAccessPayload | null => {
  try {
    const decoded = jwt.verify(token, getSecret());
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      (decoded as UserAccessPayload).type === 'user_access' &&
      'userId' in decoded
    ) {
      return decoded as UserAccessPayload;
    }
    return null;
  } catch {
    return null;
  }
};

export const verifyUserRefreshToken = (token: string): UserRefreshPayload | null => {
  try {
    const decoded = jwt.verify(token, getSecret());
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      (decoded as UserRefreshPayload).type === 'user_refresh' &&
      'userId' in decoded &&
      'jti' in decoded
    ) {
      return decoded as UserRefreshPayload;
    }
    return null;
  } catch {
    return null;
  }
};

export const hashRefreshToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

export const generateOAuthState = (returnTo: string): string => {
  const payload = {
    returnTo: returnTo.slice(0, 500),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  return jwt.sign(payload, getSecret(), { expiresIn: '10m' });
};

export const verifyOAuthState = (state: string): { returnTo: string } | null => {
  try {
    const decoded = jwt.verify(state, getSecret());
    if (typeof decoded === 'object' && decoded !== null && 'returnTo' in decoded) {
      return { returnTo: String((decoded as { returnTo: string }).returnTo) || '/' };
    }
    return null;
  } catch {
    return null;
  }
};
