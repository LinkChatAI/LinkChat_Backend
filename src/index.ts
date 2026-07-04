import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { connectDatabase } from './config/database.js';
import { closeRedis } from './config/redis.js';
import { handleSocketConnection } from './socket/handlers.js';
import roomRoutes from './routes/roomRoutes.js';
import seoRoutes from './routes/seoRoutes.js';
import nicknameRoutes from './routes/nicknameRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import fileRoutes from './routes/fileRoutes.js';
import linkPreviewRoutes from './routes/linkPreviewRoutes.js';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import toolsRoutes from './routes/toolsRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authenticateAdmin } from './middleware/adminAuth.js';
import { startCleanupJob } from './services/cleanupService.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { isRateLimitExempt } from './utils/rateLimitExempt.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

// CORS origin configuration - locked down to specific frontend URL
const getCorsOrigin = (): string | string[] => {
  const frontendUrl = env.FRONTEND_URL || env.BASE_URL;
  
  const allowedOrigins: string[] = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
  ];

  if (frontendUrl) {
    if (frontendUrl.includes(',')) {
      allowedOrigins.push(...frontendUrl.split(',').map(url => url.trim()).filter(Boolean));
    } else {
      allowedOrigins.push(frontendUrl);
    }
  }

  // Deduplicate
  const uniqueOrigins = [...new Set(allowedOrigins)];
  logger.info(`CORS configured for origins: ${uniqueOrigins.join(', ')}`);
  
  return uniqueOrigins.length === 1 ? uniqueOrigins[0] : uniqueOrigins;
};

const corsOrigin = getCorsOrigin();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Custom path avoids ad-blocker / browser-extension rules that specifically
  // target the default "/socket.io/" pattern.
  path: '/ws',
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Mobile browsers freeze background tabs, so client pings stop flowing.
  // pingInterval 25s + pingTimeout 120s keeps the raw connection alive for
  // ~2m25s of background time before the server drops it, and
  // connectionStateRecovery below covers another 2 minutes beyond that.
  pingTimeout: 120000,
  pingInterval: 25000,
  // Server accepts both transports. The production client uses websocket-only
  // (see frontend/src/services/socket.ts) to avoid the HTTP long-polling
  // "Session ID unknown" 400 errors on multi-instance Cloud Run, where polling
  // requests for one session can land on a different instance. Local dev keeps
  // polling as a fallback against a single backend instance.
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 15 * 1024 * 1024, // 15MB to accommodate 10MB files after base64 encoding (~33% overhead)
  // Restore session state (rooms + missed packets) after a brief disconnect
  // instead of forcing a full rejoin. Smooths over mobile tab freezes and
  // momentary network blips. Works across instances via the Redis adapter.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
});

// Export io instance for use in other modules
import { setIoInstance } from './socket/ioInstance.js';
setIoInstance(io);

// CORS configuration
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret'],
}));

// Security headers (hides "Powered by Express" and adds security headers)
app.use(helmet());

// Global rate limiter (for general routes)
// Allow 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: "Too many requests from this IP, please try again later." },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req) => isRateLimitExempt(req),
});

if (isRateLimitExempt()) {
  logger.info('Rate limiting disabled for local development');
}

// Apply global limiter to all API routes
app.use('/api', globalLimiter);

// Strict rate limiter — room creation only (low limit, prevents mass room spam)
// 10 room creations per hour per IP
const roomCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: "You are doing that too much. Chill for a bit." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isRateLimitExempt(req),
});

// File upload rate limiter — more lenient, normal chat usage sends many files
// 100 upload URL requests per 15 minutes per IP
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: "Too many file uploads. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isRateLimitExempt(req),
});

// Apply limits to specific heavy routes
// Room creation (POST /api/rooms)
app.post('/api/rooms', roomCreationLimiter);
// File upload URL generation
app.use('/api/files/get-upload-url', uploadLimiter);

// Body parser with size limits
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Handle local file uploads (PUT requests to /api/uploads/*) - must be before static file serving
app.use('/api/uploads', express.raw({ 
  limit: env.MAX_FILE_SIZE_BYTES + 1024,
  type: '*/*'
}), async (req, res, next) => {
  // Only handle PUT requests for file uploads
  if (req.method === 'PUT') {
    const { uploadFileHandler } = await import('./controllers/uploadController.js');
    await uploadFileHandler(req, res);
  } else {
    next();
  }
});

// Serve uploaded files (local fallback) — available at both /uploads/ and /api/uploads/
// /api/uploads/ is used by the Vite dev proxy so images load without hitting the backend port directly.
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localUploadsDir = path.join(__dirname, '../uploads');
// Uploaded file paths embed a fresh UUID per upload, so they're effectively immutable —
// safe to cache aggressively client-side.
const uploadsStaticOptions = { maxAge: '7d', immutable: true };
app.use('/uploads', express.static(localUploadsDir, uploadsStaticOptions));
app.use('/api/uploads', express.static(localUploadsDir, uploadsStaticOptions));

// Request timeout middleware
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// Readiness check endpoint
app.get('/ready', async (req, res) => {
  try {
    const mongoose = await import('mongoose');
    const redis = await import('./config/redis.js');
    
    const checks = {
      database: mongoose.default.connection.readyState === 1,
      redis: redis.isRedisAvailable(),
    };
    
    const allHealthy = Object.values(checks).every(v => v);
    
    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'ready' : 'not ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'not ready',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Database connection status endpoint (for debugging, admin-only)
app.get('/api/admin/db-status', authenticateAdmin, async (req, res) => {
  try {
    const mongoose = await import('mongoose');
    const { env } = await import('./config/env.js');
    
    const readyState = mongoose.default.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    
    res.json({
      readyState,
      state: states[readyState] || 'unknown',
      isConnected: readyState === 1,
      hasMongoUri: !!env.MONGO_URI,
      mongoUriConfigured: env.MONGO_URI ? 'Yes (hidden)' : 'No',
      host: mongoose.default.connection.host || 'N/A',
      database: mongoose.default.connection.db?.databaseName || 'N/A',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Manual database reconnection endpoint (for debugging, admin-only).
// Unauthenticated, this let anyone force a disconnect/reconnect cycle
// (5 retries with delays) — a trivial DoS against the connection pool.
app.post('/api/admin/reconnect-db', authenticateAdmin, async (req, res) => {
  try {
    const { connectDatabase } = await import('./config/database.js');
    const mongoose = await import('mongoose');
    
    // If already connected, disconnect first
    if (mongoose.default.connection.readyState === 1) {
      await mongoose.default.disconnect();
      logger.info('Disconnected from MongoDB before reconnection');
    }
    
    // Attempt reconnection
    await connectDatabase();
    
    const isConnected = mongoose.default.connection.readyState === 1;
    
    res.json({
      success: isConnected,
      message: isConnected ? 'Database reconnected successfully' : 'Database reconnection failed',
      readyState: mongoose.default.connection.readyState,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error('Manual reconnection failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// SEO routes
app.use('/', seoRoutes);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/nickname', nicknameRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/files', fileRoutes);

// Link preview (OG cards) with rate limit
const linkPreviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many link preview requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isRateLimitExempt(req),
});
app.use('/api/link-preview', linkPreviewLimiter, linkPreviewRoutes);

app.use(errorHandler);

io.on('connection', async (socket) => {
  logger.debug('Socket connected', { socketId: socket.id });
  
  // Admin dashboard socket (separate from room chat sockets)
  const adminSecret = socket.handshake.auth?.adminSecret || socket.handshake.query?.adminSecret;
  if (adminSecret) {
    if (env.ADMIN_SECRET && adminSecret === env.ADMIN_SECRET) {
      const { handleAdminSocketConnection } = await import('./socket/adminHandlers.js');
      handleAdminSocketConnection(io, socket);
    } else {
      logger.warn('Rejected admin socket: invalid secret', { socketId: socket.id });
      socket.emit('error', { message: 'Unauthorized admin connection' });
      socket.disconnect(true);
    }
    return;
  }

  handleSocketConnection(io, socket);
});

let cleanupJobInterval: NodeJS.Timeout | null = null;
let autoVanishInterval: NodeJS.Timeout | null = null;
let adapterPubClient: any = null;
let adapterSubClient: any = null;

// Wire the Socket.IO Redis adapter so broadcasts (newMessage, etc.) reach
// clients connected to OTHER Cloud Run instances. Without this, a message sent
// on instance A is never delivered to a user on instance B. Falls back silently
// to the in-memory adapter (single-instance) when Redis is unavailable.
const setupRedisAdapter = async (): Promise<void> => {
  // The Redis adapter only matters when running multiple instances (production
  // on Cloud Run). Local dev is a single instance, so skip it entirely and
  // avoid the startup connection attempt / log noise. Set REDIS_ADAPTER=1 to
  // force it on in development (e.g. to test multi-instance locally).
  const wantAdapter = process.env.NODE_ENV === 'production' || process.env.REDIS_ADAPTER === '1';
  if (!wantAdapter) {
    logger.info('Socket.IO using in-memory adapter (development, single instance)');
    return;
  }
  if (!env.REDIS_URL) {
    logger.warn('REDIS_URL not set — Socket.IO using in-memory adapter (safe only for a single instance)');
    return;
  }
  try {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const { default: Redis } = await import('ioredis');

    const RedisClass = Redis as any;
    // lazyConnect so we can verify reachability ONCE before wiring the adapter.
    // Without this, an unreachable Redis (e.g. REDIS_URL set in local dev but no
    // server running) makes ioredis retry every second forever and spam logs.
    const clientOpts = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null, // recommended for the pub/sub clients
      // Give up after ~5 quick attempts; we fall back to the in-memory adapter.
      retryStrategy: (times: number) => (times > 5 ? null : Math.min(times * 200, 2000)),
    };
    adapterPubClient = new RedisClass(env.REDIS_URL, clientOpts);
    adapterSubClient = new RedisClass(env.REDIS_URL, clientOpts);

    // Suppress connection-refused noise (Redis is optional); these clients are
    // torn down below if the initial connect fails.
    const isConnRefused = (err: any) =>
      ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err?.code) ||
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i.test(err?.message || '');
    adapterPubClient.on('error', (err: any) => {
      if (!isConnRefused(err)) logger.error('Redis adapter pub client error', { error: err?.message || String(err) });
    });
    adapterSubClient.on('error', (err: any) => {
      if (!isConnRefused(err)) logger.error('Redis adapter sub client error', { error: err?.message || String(err) });
    });

    // Verify both clients can actually connect before wiring the adapter.
    await Promise.all([adapterPubClient.connect(), adapterSubClient.connect()]);

    io.adapter(createAdapter(adapterPubClient, adapterSubClient));
    logger.info('Socket.IO Redis adapter enabled (cross-instance broadcasting active)');
  } catch (error: any) {
    // Redis unreachable — tear down the clients so they stop retrying, and run
    // with the in-memory adapter. Fine for a single instance (local dev);
    // multi-instance production must provide a reachable REDIS_URL.
    logger.warn('Redis unreachable — Socket.IO using in-memory adapter (safe only for a single instance)', {
      error: error instanceof Error ? error.message : String(error),
    });
    try { if (adapterPubClient) adapterPubClient.disconnect(); } catch { /* ignore */ }
    try { if (adapterSubClient) adapterSubClient.disconnect(); } catch { /* ignore */ }
    adapterPubClient = null;
    adapterSubClient = null;
  }
};

const startServer = () => {
  // Start server immediately - don't wait for anything
  // This ensures Cloud Run health checks pass
  try {
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info('Server started', { port: PORT, env: process.env.NODE_ENV || 'development' });
    });

    // Handle server errors gracefully
    httpServer.on('error', (error: any) => {
      logger.error('HTTP server error', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    });
  } catch (error: any) {
    logger.error('Failed to start HTTP server', { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    // Still try to start - don't exit
  }

  // Connect to database asynchronously (non-blocking)
  // Server will still respond to health checks even if DB is not ready
  // Start connection immediately but don't block server startup
  // In development, log connection attempts more clearly
  if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    logger.info('Starting MongoDB connection in development mode...');
  }
  connectDatabase().catch((error: any) => {
    logger.error('Failed to connect to database', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    // Don't exit - server can still serve health checks
    // Connection will retry automatically in connectDatabase function
  });

  // Wire the Redis adapter for multi-instance Socket.IO broadcasting (non-blocking)
  setupRedisAdapter().catch((error: any) => {
    logger.error('Redis adapter setup threw', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Start cleanup job (non-blocking)
  try {
    cleanupJobInterval = startCleanupJob();
  } catch (error: any) {
    logger.error('Failed to start cleanup job', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    // Don't exit - server can still run
  }

  // Start auto-vanish worker (non-blocking)
  (async () => {
    try {
      const { startAutoVanishWorker } = await import('./services/autoVanishService.js');
      autoVanishInterval = startAutoVanishWorker();
      logger.info('Auto-vanish worker started');
    } catch (error: any) {
      logger.error('Failed to start auto-vanish worker', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      // Don't exit - server can still run
    }
  })();
};

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info('Shutdown signal received', { signal });
  
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });

  io.close(() => {
    logger.info('Socket.IO server closed');
  });

  if (cleanupJobInterval) {
    clearInterval(cleanupJobInterval);
  }

  if (autoVanishInterval) {
    clearInterval(autoVanishInterval);
  }

  try {
    await closeRedis();
    if (adapterPubClient) await adapterPubClient.quit().catch(() => {});
    if (adapterSubClient) await adapterSubClient.quit().catch(() => {});
    const mongoose = await import('mongoose');
    await mongoose.default.disconnect();
    logger.info('Database connections closed');
  } catch (error: any) {
    logger.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) });
  }

  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors - don't crash, just log
// This prevents the container from crashing on startup
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { 
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  // Don't call shutdown - let server keep running for Cloud Run
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { 
    reason: reason instanceof Error ? reason.message : String(reason) 
  });
  // Don't crash - just log
});

// Start server immediately - must be at module level for immediate execution
startServer();
