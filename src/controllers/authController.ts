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
import { generateUserAccessToken } from '../utils/userJwt.js';
import { getUserById } from '../services/authService.js';
import { createSessionExchangeCode, consumeSessionExchangeCode } from '../services/sessionExchangeService.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

const isProduction = env.NODE_ENV === 'production';

const getFrontendUrl = (): string => {
  const url = env.FRONTEND_URL || env.BASE_URL?.split(',')[0]?.trim() || 'http://localhost:5173';
  return url;
};

const baseCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

const setAccessTokenCookie = (res: Response, accessToken: string): void => {
  res.cookie('lc_access_token', accessToken, {
    ...baseCookieOptions,
    maxAge: 15 * 60 * 1000,
  });
};

const setAuthCookies = (res: Response, accessToken: string, refreshToken: string): void => {
  setAccessTokenCookie(res, accessToken);

  res.cookie('lc_refresh_token', refreshToken, {
    ...baseCookieOptions,
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
    // No session — 200 avoids noisy 401 console errors for anonymous visitors
    res.status(200).json(null);
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
    role: user.role,
    credits: user.credits,
  });
};

export const refreshHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  const refreshToken = req.cookies?.lc_refresh_token;
  if (!refreshToken) {
    // No refresh cookie — guest user; 200 keeps the browser console clean
    res.status(200).json({ user: null });
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

/**
 * Step 1 of the cross-domain session bridge (see sessionExchangeService.ts):
 * called from linkchat.in (proxied through Netlify, so it carries the
 * primary lc_access_token cookie normally) to mint a short-lived, single-use
 * code proving "this browser is already logged in as this user".
 */
export const createSessionExchangeHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  const code = await createSessionExchangeCode(req.user.userId);
  if (!code) {
    res.status(503).json({ error: 'Session exchange unavailable' });
    return;
  }

  res.json({ code });
};

/**
 * Step 2: called directly against the backend's own domain (cross-origin
 * from linkchat.in, credentials included — CORS already allows this origin
 * with credentials, see index.ts). Redeems the one-time code and sets an
 * independent access-token cookie scoped to this domain, so a socket
 * handshake landing here (see utils/ghostMode.ts) can see a session too.
 * Deliberately access-token only, no refresh token — this is a short-lived
 * bridge, not a parallel login; the frontend re-runs the exchange whenever
 * it refreshes its own session (see AuthContext.tsx), which naturally keeps
 * this cookie from going stale for as long as the user stays logged in.
 */
export const consumeSessionExchangeHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    res.status(400).json({ error: 'Missing code' });
    return;
  }

  const userId = await consumeSessionExchangeCode(code);
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired code', code: 'EXCHANGE_INVALID' });
    return;
  }

  const user = await getUserById(userId);
  if (!user || user.status !== 'active') {
    res.status(401).json({ error: 'Account not available', code: 'AUTH_INVALID' });
    return;
  }

  const accessToken = generateUserAccessToken(userId, user.email, user.plan);
  setAccessTokenCookie(res, accessToken);
  res.json({ success: true });
};
