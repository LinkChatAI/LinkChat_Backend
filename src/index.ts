import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { connectDatabase } from './config/database';
import { closeRedis } from './config/redis';
import { handleSocketConnection } from './socket/handlers';
import roomRoutes from './routes/roomRoutes';
import seoRoutes from './routes/seoRoutes';
import { errorHandler } from './middleware/errorHandler';
import { startCleanupJob } from './services/cleanupService';
import { logger } from './utils/logger';
import { env } from './config/env';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: env.FRONTEND_URL || env.BASE_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

// CORS configuration
app.use(cors({
  origin: env.FRONTEND_URL || env.BASE_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parser with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    const redis = await import('./config/redis');
    
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
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// SEO routes
app.use('/', seoRoutes);

// API routes
app.use('/api/rooms', roomRoutes);

app.use(errorHandler);

io.on('connection', (socket) => {
  logger.debug('Socket connected', { socketId: socket.id });
  handleSocketConnection(io, socket);
});

let cleanupJobInterval: NodeJS.Timeout | null = null;

const startServer = async () => {
  try {
    await connectDatabase();
    cleanupJobInterval = startCleanupJob();
    httpServer.listen(env.PORT, () => {
      logger.info('Server started', { port: env.PORT, env: env.NODE_ENV });
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
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

  try {
    await closeRedis();
    const mongoose = await import('mongoose');
    await mongoose.default.disconnect();
    logger.info('Database connections closed');
  } catch (error) {
    logger.error('Error during shutdown', { error });
  }

  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
});

startServer();
