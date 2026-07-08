import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { UserModel, IUser } from '../models/User.js';
import {
  generateUserAccessToken,
  generateUserRefreshToken,
  hashRefreshToken,
  verifyUserRefreshToken,
} from '../utils/userJwt.js';
import { logger } from '../utils/logger.js';
import { UserPlan } from '../types/index.js';

let oauthClient: OAuth2Client | null = null;

const getOAuthClient = (): OAuth2Client => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured');
  }
  if (!oauthClient) {
    oauthClient = new OAuth2Client(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_OAUTH_REDIRECT_URI
    );
  }
  return oauthClient;
};

export const isGoogleOAuthConfigured = (): boolean => {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI);
};

export const getGoogleAuthUrl = (state: string): string => {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['openid', 'email', 'profile'],
    state,
  });
};

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatar?: string;
    plan: UserPlan;
    role: string;
    credits: number;
  };
}

export const handleGoogleCallback = async (code: string): Promise<AuthTokens> => {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.id_token) {
    throw new Error('No ID token received from Google');
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error('Invalid Google token payload');
  }

  if (!payload.email_verified) {
    throw new Error('Google email is not verified');
  }

  let user = await UserModel.findOne({ googleId: payload.sub });

  if (!user) {
    const existingByEmail = await UserModel.findOne({ email: payload.email.toLowerCase() });
    if (existingByEmail) {
      existingByEmail.googleId = payload.sub;
      existingByEmail.name = payload.name || existingByEmail.name;
      existingByEmail.avatar = payload.picture || existingByEmail.avatar;
      existingByEmail.lastLoginAt = new Date();
      await existingByEmail.save();
      user = existingByEmail;
    } else {
      user = await UserModel.create({
        googleId: payload.sub,
        email: payload.email.toLowerCase(),
        name: payload.name || payload.email.split('@')[0],
        avatar: payload.picture,
        plan: 'free' as UserPlan,
        lastLoginAt: new Date(),
      });
      logger.info('New user registered via Google OAuth', { userId: user._id, email: user.email });
    }
  } else {
    user.name = payload.name || user.name;
    user.avatar = payload.picture || user.avatar;
    user.lastLoginAt = new Date();
    await user.save();
  }

  return issueTokensForUser(user);
};

export const issueTokensForUser = async (user: IUser & { _id: { toString(): string } }): Promise<AuthTokens> => {
  const userId = user._id.toString();
  const { token: refreshToken } = generateUserRefreshToken(userId);
  const refreshTokenHash = hashRefreshToken(refreshToken);

  await UserModel.updateOne({ _id: user._id }, { refreshTokenHash });

  const accessToken = generateUserAccessToken(userId, user.email, user.plan);

  return {
    accessToken,
    refreshToken,
    user: {
      id: userId,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      plan: user.plan,
      role: user.role,
      credits: user.credits,
    },
  };
};

export const refreshUserTokens = async (refreshToken: string): Promise<AuthTokens | null> => {
  const decoded = verifyUserRefreshToken(refreshToken);
  if (!decoded) return null;

  const user = await UserModel.findById(decoded.userId);
  if (!user) return null;

  const tokenHash = hashRefreshToken(refreshToken);
  if (user.refreshTokenHash !== tokenHash) {
    logger.warn('Refresh token reuse detected — revoking session', { userId: decoded.userId });
    await UserModel.updateOne({ _id: user._id }, { $unset: { refreshTokenHash: 1 } });
    return null;
  }

  return issueTokensForUser(user);
};

export const revokeUserSession = async (userId: string): Promise<void> => {
  await UserModel.updateOne({ _id: userId }, { $unset: { refreshTokenHash: 1 } });
};

export const linkGuestToUser = async (userId: string, guestId: string): Promise<void> => {
  await UserModel.updateOne({ _id: userId }, { linkedGuestId: guestId });
};

export const getUserById = async (userId: string): Promise<IUser | null> => {
  return UserModel.findById(userId).lean();
};
