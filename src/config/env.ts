import dotenv from 'dotenv';
import { logger } from '../utils/logger';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend folder (one level up from this file: backend/src/config -> backend)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface EnvConfig {
  PORT: number;
  NODE_ENV: string;
  MONGO_URI: string;
  REDIS_URL: string;
  JWT_SECRET: string;
  ROOM_CODE_LENGTH: number;
  DEFAULT_ROOM_EXP_HOURS: number;
  MAX_FILE_SIZE_BYTES: number;
  BASE_URL: string;
  SITE_TITLE: string;
  SITE_DESCRIPTION: string;
  DEFAULT_OG_IMAGE: string;
  FRONTEND_URL?: string;
  GCS_BUCKET?: string;
  GCS_PROJECT_ID?: string;
  GCS_CLIENT_EMAIL?: string;
  GCS_PRIVATE_KEY?: string;
}

const requiredEnvVars = [
  'MONGO_URI',
  'REDIS_URL',
  'JWT_SECRET',
] as const;

const validateEnv = (): EnvConfig => {
  const missing: string[] = [];

  requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  });

  if (missing.length > 0) {
    const error = `Missing required environment variables: ${missing.join(', ')}. Please check your .env file.`;
    logger.error(error);
    throw new Error(error);
  }

  return {
    PORT: parseInt(process.env.PORT || '8080', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
    MONGO_URI: process.env.MONGO_URI!,
    REDIS_URL: process.env.REDIS_URL!,
    JWT_SECRET: process.env.JWT_SECRET!,
    ROOM_CODE_LENGTH: parseInt(process.env.ROOM_CODE_LENGTH || '4', 10),
    DEFAULT_ROOM_EXP_HOURS: parseInt(process.env.DEFAULT_ROOM_EXP_HOURS || '24', 10),
    MAX_FILE_SIZE_BYTES: parseInt(process.env.MAX_FILE_SIZE_BYTES || '25000000', 10),
    BASE_URL: process.env.BASE_URL || 'http://localhost:5173',
    SITE_TITLE: process.env.SITE_TITLE || 'LinkChat',
    SITE_DESCRIPTION: process.env.SITE_DESCRIPTION || 'Instant temporary chat rooms — create a room, share a 4-digit code or QR, join from any device.',
    DEFAULT_OG_IMAGE: process.env.DEFAULT_OG_IMAGE || '/assets/og-default.png',
    FRONTEND_URL: process.env.FRONTEND_URL,
    GCS_BUCKET: process.env.GCS_BUCKET,
    GCS_PROJECT_ID: process.env.GCS_PROJECT_ID,
    GCS_CLIENT_EMAIL: process.env.GCS_CLIENT_EMAIL,
    GCS_PRIVATE_KEY: process.env.GCS_PRIVATE_KEY,
  };
};

export const env = validateEnv();
