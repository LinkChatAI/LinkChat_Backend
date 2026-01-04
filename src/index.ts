import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { connectDatabase } from './config/database.js';
import { closeRedis } from './config/redis.js';
import { handleSocketConnection } from './socket/handlers.js';
import roomRoutes from './routes/roomRoutes.js';
import seoRoutes from './routes/seoRoutes.js';
import nicknameRoutes from './routes/nicknameRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startCleanupJob } from './services/cleanupService.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

// CORS origin configuration - supports multiple origins
const getCorsOrigin = (): string | string[] | boolean => {
  const frontendUrl = env.FRONTEND_URL || env.BASE_URL;
  
  // If no URL is set, allow all origins (development only)
  if (!frontendUrl) {
    if (env.NODE_ENV === 'production') {
      logger.warn('No FRONTEND_URL or BASE_URL set in production. CORS will allow all origins.');
      return true; // Allow all in production if not configured (not ideal but won't break)
    }
    return true; // Allow all in development
  }
  
  // Support comma-separated list of origins
  if (frontendUrl.includes(',')) {
    return frontendUrl.split(',').map(url => url.trim()).filter(Boolean);
  }
  
  return frontendUrl;
};

const corsOrigin = getCorsOrigin();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 15 * 1024 * 1024, // 15MB to accommodate 10MB files after base64 encoding (~33% overhead)
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

// Body parser with size limits
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

// Serve uploaded files (local fallback)
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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

// Database connection status endpoint (for debugging)
app.get('/api/admin/db-status', async (req, res) => {
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

// Manual database reconnection endpoint (for debugging)
app.post('/api/admin/reconnect-db', async (req, res) => {
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
app.use('/api/rooms', roomRoutes);
app.use('/api/nickname', nicknameRoutes);
app.use('/api/admin', adminRoutes);

app.use(errorHandler);

io.on('connection', async (socket) => {
  logger.debug('Socket connected', { socketId: socket.id });
  
  // Check if this is an admin connection
  const adminSecret = socket.handshake.auth?.adminSecret || socket.handshake.query?.adminSecret;
  if (adminSecret && adminSecret === env.ADMIN_SECRET) {
    const { handleAdminSocketConnection } = await import('./socket/adminHandlers.js');
    handleAdminSocketConnection(io, socket);
  } else {
    handleSocketConnection(io, socket);
  }
});

let cleanupJobInterval: NodeJS.Timeout | null = null;
let autoVanishInterval: NodeJS.Timeout | null = null;

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
