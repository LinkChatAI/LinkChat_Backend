import { Response } from 'express';
import { UserAuthRequest } from '../middleware/userAuth.js';
import { env } from '../config/env.js';
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  refreshUserTokens,
  revokeUserSession,
  linkGuestToUser,
  isGoogleOAuthConfigured,
} from '../services/authService.js';
import { generateOAuthState, verifyOAuthState } from '../utils/userJwt.js';
import { getUserById } from '../services/authService.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

const isProduction = env.NODE_ENV === 'production';

const getFrontendUrl = (): string => {
  const url = env.FRONTEND_URL || env.BASE_URL?.split(',')[0]?.trim() || 'http://localhost:5173';
  return url;
};

const setAuthCookies = (res: Response, accessToken: string, refreshToken: string): void => {
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
  };

  res.cookie('lc_access_token', accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000,
  });

  res.cookie('lc_refresh_token', refreshToken, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  });
};

const clearAuthCookies = (res: Response): void => {
  const clearOptions = {
    path: '/',
    secure: isProduction,
    sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
  };
  res.clearCookie('lc_access_token', clearOptions);
  res.clearCookie('lc_refresh_token', { ...clearOptions, path: '/api/auth' });
};

export const googleAuthHandler = (req: UserAuthRequest, res: Response): void => {
  if (!isGoogleOAuthConfigured()) {
    res.status(503).json({ error: 'Google OAuth is not configured', code: 'OAUTH_NOT_CONFIGURED' });
    return;
  }

  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
  const state = generateOAuthState(returnTo);
  const authUrl = getGoogleAuthUrl(state);
  res.redirect(authUrl);
};

export const googleCallbackHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  const frontendUrl = getFrontendUrl();

  try {
    if (!isGoogleOAuthConfigured()) {
      res.redirect(`${frontendUrl}/auth/callback?error=oauth_not_configured`);
      return;
    }

    const { code, state, error } = req.query;

    if (error || !code || typeof code !== 'string') {
      res.redirect(`${frontendUrl}/auth/callback?error=oauth_denied`);
      return;
    }

    const stateData = typeof state === 'string' ? verifyOAuthState(state) : null;
    const returnTo = stateData?.returnTo || '/';

    const tokens = await handleGoogleCallback(code);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    const safeReturnTo = returnTo.startsWith('/') ? returnTo : '/';
    res.redirect(`${frontendUrl}/auth/callback?success=true&returnTo=${encodeURIComponent(safeReturnTo)}`);
  } catch (err) {
    logger.error('Google OAuth callback failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.redirect(`${frontendUrl}/auth/callback?error=oauth_failed`);
  }
};

export const getMeHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated', code: 'AUTH_REQUIRED' });
    return;
  }

  const user = await getUserById(req.user.userId);
  if (!user) {
    res.status(401).json({ error: 'User not found', code: 'AUTH_INVALID' });
    return;
  }

  res.json({
    id: req.user.userId,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    plan: user.plan,
    linkedGuestId: user.linkedGuestId,
  });
};

export const refreshHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  const refreshToken = req.cookies?.lc_refresh_token;
  if (!refreshToken) {
    res.status(401).json({ error: 'No refresh token', code: 'AUTH_REQUIRED' });
    return;
  }

  const tokens = await refreshUserTokens(refreshToken);
  if (!tokens) {
    clearAuthCookies(res);
    res.status(401).json({ error: 'Invalid refresh token', code: 'AUTH_INVALID' });
    return;
  }

  setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
  res.json({ user: tokens.user });
};

export const logoutHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  if (req.user) {
    await revokeUserSession(req.user.userId);
  }
  clearAuthCookies(res);
  res.json({ success: true });
};

const linkGuestSchema = z.object({
  guestId: z.string().uuid(),
});

export const linkGuestHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  try {
    const body = linkGuestSchema.parse(req.body);
    await linkGuestToUser(req.user.userId, body.guestId);

    const { RoomModel } = await import('../models/Room.js');
    await RoomModel.updateMany(
      { ownerId: body.guestId, ownerUserId: { $exists: false } },
      { $set: { ownerUserId: req.user.userId } }
    );

    res.json({ success: true, guestId: body.guestId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid guest ID', details: error.errors });
      return;
    }
    res.status(500).json({ error: 'Failed to link guest session' });
  }
};

export const authStatusHandler = (_req: UserAuthRequest, res: Response): void => {
  res.json({
    oauthConfigured: isGoogleOAuthConfigured(),
  });
};
