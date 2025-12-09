import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { env } from './env';

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

export const connectDatabase = async (retries = 0): Promise<void> => {
  try {
    await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    logger.info('Connected to MongoDB');
    
    mongoose.connection.on('error', (error) => {
      logger.error('MongoDB connection error', { error });
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
    
    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });
  } catch (error) {
    logger.error('MongoDB connection error', { error, retries });
    
    if (retries < MAX_RETRIES) {
      logger.info(`Retrying MongoDB connection in ${RETRY_DELAY}ms...`, { retries: retries + 1 });
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectDatabase(retries + 1);
    }
    
    throw error;
  }
};

