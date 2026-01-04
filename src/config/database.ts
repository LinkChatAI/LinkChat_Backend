import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { env } from './env.js';

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

export const connectDatabase = async (retries = 0): Promise<void> => {
  if (!env.MONGO_URI) {
    logger.warn('MONGO_URI not set, skipping database connection');
    logger.warn('Set MONGO_URI in .env file to enable database connection');
    return;
  }
  
  if (env.MONGO_URI.trim().length === 0) {
    logger.warn('MONGO_URI is empty, skipping database connection');
    return;
  }

  // Declare mongoUri outside try block so it's accessible in catch
  let mongoUri = env.MONGO_URI.trim();
  
  // In development, log connection attempt
  if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    logger.info('Attempting MongoDB connection...', {
      retries,
      uri: mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')
    });
  }

  try {
    // MongoDB Atlas connection options
    const connectionOptions: mongoose.ConnectOptions = {
      serverSelectionTimeoutMS: 30000, // Increased timeout for Atlas
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 2,
      retryWrites: true,
      w: 'majority',
      // Don't set authSource - let MongoDB use the default from connection string
    };
    
    // Ensure MongoDB URI has proper format (mongoUri already declared above)
    
    // Validate URI format
    if (!mongoUri.startsWith('mongodb://') && !mongoUri.startsWith('mongodb+srv://')) {
      throw new Error('Invalid MongoDB URI format. Must start with mongodb:// or mongodb+srv://');
    }
    
    // URL encode password properly for MongoDB connection string
    // MongoDB Atlas requires URL-encoded passwords in connection strings
    const uriPattern = /^(mongodb\+srv?:\/\/)([^:]+):([^@]+)@(.+)$/;
    const match = mongoUri.match(uriPattern);
    if (match) {
      const [, protocol, username, password, rest] = match;
      try {
        // Try to decode to check if already encoded
        const decoded = decodeURIComponent(password);
        // If decode works and result is different, it was encoded
        // If decode fails or result is same, it needs encoding
        if (decoded === password) {
          // Not encoded, encode it
          const encodedPassword = encodeURIComponent(password);
          mongoUri = `${protocol}${username}:${encodedPassword}@${rest}`;
          if (retries === 0) {
            logger.debug('URL-encoded password in MongoDB URI for proper authentication');
          }
        }
      } catch (e) {
        // Decode failed, password might be malformed, try encoding anyway
        const encodedPassword = encodeURIComponent(password);
        mongoUri = `${protocol}${username}:${encodedPassword}@${rest}`;
        logger.debug('URL-encoded password (decode failed, encoding anyway)');
      }
    }
    
    // Check if URI already has a database name
    const hasDatabaseName = mongoUri.match(/\/[^\/\?]+(\?|$)/);
    
    // If URI ends with just /, add database name
    if (mongoUri.endsWith('/') && !mongoUri.endsWith('//')) {
      mongoUri = mongoUri + 'linkchat';
      logger.info('Added database name "linkchat" to MONGO_URI');
    } else if (!hasDatabaseName && mongoUri.includes('@')) {
      // URI has credentials but no database name
      const parts = mongoUri.split('?');
      const baseUri = parts[0];
      const queryString = parts[1] ? '?' + parts[1] : '';
      if (baseUri.endsWith('/')) {
        mongoUri = baseUri + 'linkchat' + queryString;
      } else {
        mongoUri = baseUri + '/linkchat' + queryString;
      }
      logger.info('Added database name "linkchat" to MONGO_URI');
    } else if (!hasDatabaseName) {
      // No credentials and no database name - add it
      const parts = mongoUri.split('?');
      const baseUri = parts[0];
      const queryString = parts[1] ? '?' + parts[1] : '';
      if (baseUri.endsWith('/')) {
        mongoUri = baseUri + 'linkchat' + queryString;
      } else {
        mongoUri = baseUri + '/linkchat' + queryString;
      }
      logger.info('Added database name "linkchat" to MONGO_URI');
    }
    
    logger.debug('Using MongoDB URI', { 
      uri: mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'),
      hasDatabase: !!mongoUri.match(/\/[^\/\?]+(\?|$)/)
    });
    
    // Attempt connection
    await mongoose.connect(mongoUri, connectionOptions);
    
    // Wait a moment for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify connection is actually ready
    const readyState = mongoose.connection.readyState;
    if (readyState === 1) {
      const dbName = mongoose.connection.db?.databaseName || 'unknown';
      const host = mongoose.connection.host || 'unknown';
      
      logger.info('✅ Connected to MongoDB successfully', { 
        database: dbName,
        host: host,
        readyState: readyState,
        port: mongoose.connection.port || 'default'
      });
      
      // Verify we can actually use the database
      try {
        if (mongoose.connection.db) {
          await mongoose.connection.db.admin().ping();
          logger.debug('MongoDB ping successful - connection is fully operational');
        }
      } catch (pingError) {
        logger.warn('MongoDB connected but ping failed', { 
          error: pingError instanceof Error ? pingError.message : String(pingError) 
        });
      }
    } else {
      const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
      throw new Error(`Connection established but readyState is ${readyState} (${states[readyState] || 'unknown'}), expected 1 (connected)`);
    }
    
    mongoose.connection.on('error', (error) => {
      logger.error('MongoDB connection error', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
    
    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error && typeof error === 'object' && 'name' in error ? (error as any).name : 'Unknown';
    
    logger.error('MongoDB connection error', { 
      error: errorMessage,
      errorName,
      retries,
      mongoUri: mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') // Hide credentials in logs
    });
    
    // Log specific error details for debugging
    if (errorName === 'MongoServerSelectionError' || errorName === 'MongoNetworkError') {
      logger.error('Network/Server selection error - check network connection and MongoDB Atlas IP whitelist');
      logger.error('TIP: Go to MongoDB Atlas → Network Access → Add IP Address (or use 0.0.0.0/0 for dev)');
    } else if (errorName === 'MongoAuthenticationError' || errorName === 'MongoServerError') {
      if (errorMessage.includes('bad auth') || errorMessage.includes('Authentication failed')) {
        logger.error('❌ AUTHENTICATION FAILED - MongoDB credentials are incorrect');
        logger.error('Solutions:');
        logger.error('1. Verify username and password in MONGO_URI');
        logger.error('2. Check if password contains special characters that need URL encoding');
        logger.error('3. Verify user exists in MongoDB Atlas and has proper permissions');
        logger.error('4. Try resetting the password in MongoDB Atlas');
        logger.error('5. Make sure the database user has access to the "linkchat" database');
      } else {
        logger.error('Authentication error - check MongoDB username and password in MONGO_URI');
      }
    } else if (errorName === 'MongoTimeoutError') {
      logger.error('Connection timeout - check network connectivity and MongoDB Atlas cluster status');
    }
    
    if (retries < MAX_RETRIES) {
      logger.info(`Retrying MongoDB connection in ${RETRY_DELAY}ms...`, { retries: retries + 1 });
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectDatabase(retries + 1);
    }
    
    // Don't throw - allow server to continue running
    // The /ready endpoint will show database status
    logger.warn('MongoDB connection failed after retries. Server will continue but database operations will fail.');
    logger.warn('To fix: Check MONGO_URI, network connection, and MongoDB Atlas IP whitelist settings.');
  }
};

