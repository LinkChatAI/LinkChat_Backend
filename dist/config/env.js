import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Determine which .env file to load based on NODE_ENV
const nodeEnv = process.env.NODE_ENV || 'development';
const backendDir = path.resolve(__dirname, '../../');
// Load environment-specific .env file
if (nodeEnv === 'production') {
    // Try .env.production first, then fallback to .env
    dotenv.config({ path: path.resolve(backendDir, '.env.production') });
    dotenv.config({ path: path.resolve(backendDir, '.env') }); // Fallback
}
else {
    // Development: load .env
    dotenv.config({ path: path.resolve(backendDir, '.env') });
}
// Also load from process.env (for Cloud Run, Docker, etc.)
dotenv.config();
const requiredEnvVars = [
    'MONGO_URI',
    'REDIS_URL',
    'JWT_SECRET',
];
const validateEnv = () => {
    // Don't throw errors - just log warnings and use defaults/empty strings
    // This allows the server to start even if env vars are missing
    const missing = [];
    requiredEnvVars.forEach((varName) => {
        if (!process.env[varName]) {
            missing.push(varName);
        }
    });
    if (missing.length > 0) {
        logger.warn(`Missing environment variables: ${missing.join(', ')}. Some features may not work.`);
    }
    // URLs must be set via environment variables
    const devBackendDefault = nodeEnv === 'development' ? 'http://localhost:8080' : '';
    const defaultBackendUrl = process.env.BACKEND_URL || devBackendDefault;
    const defaultBaseUrl = process.env.BASE_URL || process.env.FRONTEND_URL || '';
    if (!process.env.BASE_URL) {
        logger.warn('BASE_URL not set. SEO features, QR codes, and link sharing may not work correctly.');
    }
    if (!process.env.BACKEND_URL && nodeEnv !== 'development') {
        logger.warn('BACKEND_URL not set. Some features may not work correctly.');
    }
    return {
        PORT: parseInt(process.env.PORT || '8080', 10),
        NODE_ENV: nodeEnv,
        MONGO_URI: process.env.MONGO_URI || '',
        REDIS_URL: process.env.REDIS_URL || '',
        JWT_SECRET: process.env.JWT_SECRET || 'default-secret-change-in-production',
        ROOM_CODE_LENGTH: parseInt(process.env.ROOM_CODE_LENGTH || '4', 10),
        DEFAULT_ROOM_EXP_HOURS: parseFloat(process.env.DEFAULT_ROOM_EXP_HOURS || '0.833333'), // 50 minutes default
        MAX_FILE_SIZE_BYTES: parseInt(process.env.MAX_FILE_SIZE_BYTES || '314572800', 10), // 300MB default (was 10MB)
        BASE_URL: process.env.BASE_URL || defaultBaseUrl,
        BACKEND_URL: process.env.BACKEND_URL || defaultBackendUrl,
        SITE_TITLE: process.env.SITE_TITLE || 'LinkChat',
        SITE_DESCRIPTION: process.env.SITE_DESCRIPTION || 'Instant temporary chat rooms — create a room, share a 4-digit code or QR, join from any device.',
        DEFAULT_OG_IMAGE: process.env.DEFAULT_OG_IMAGE || '/assets/og-default.png',
        FRONTEND_URL: process.env.FRONTEND_URL,
        GCS_BUCKET: process.env.GCS_BUCKET,
        GCS_PROJECT_ID: process.env.GCS_PROJECT_ID,
        GCS_CLIENT_EMAIL: process.env.GCS_CLIENT_EMAIL,
        GCS_PRIVATE_KEY: process.env.GCS_PRIVATE_KEY,
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
        ADMIN_SECRET: process.env.ADMIN_SECRET,
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
        USER_JWT_SECRET: process.env.USER_JWT_SECRET || process.env.JWT_SECRET,
        // Defaults raised from the driver defaults (10/2) so a burst of concurrent
        // message/join queries during a participant spike doesn't queue behind a
        // small connection pool.
        MONGO_MAX_POOL_SIZE: parseInt(process.env.MONGO_MAX_POOL_SIZE || '50', 10),
        MONGO_MIN_POOL_SIZE: parseInt(process.env.MONGO_MIN_POOL_SIZE || '5', 10),
        PERMANENT_ADMIN_EMAILS: process.env.PERMANENT_ADMIN_EMAILS,
        RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
        RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
        // Hardcoded default so Ghost Mode works even if Cloud Run env config is
        // incomplete (see prior GOOGLE_CLIENT_ID config-drift incident); still
        // overridable via env var to add/remove Super Admins without a redeploy.
        GHOST_MODE_ADMIN_EMAILS: process.env.GHOST_MODE_ADMIN_EMAILS || 'wordtheme44@gmail.com,m87.krishna@gmail.com',
    };
};
export const env = validateEnv();
//# sourceMappingURL=env.js.map