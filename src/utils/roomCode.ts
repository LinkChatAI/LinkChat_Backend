import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const generateRoomCode = async (): Promise<string> => {
  // Check if database is connected
  if (mongoose.connection.readyState !== 1) {
    logger.error('Database not connected when generating room code');
    throw new Error('Database connection not available');
  }

  try {
    let code: string;
    let exists = true;
    const maxAttempts = 100;
    let attempts = 0;

    while (exists && attempts < maxAttempts) {
      const min = Math.pow(10, env.ROOM_CODE_LENGTH - 1);
      const max = Math.pow(10, env.ROOM_CODE_LENGTH) - 1;
      code = Math.floor(min + Math.random() * (max - min + 1)).toString();
      const room = await RoomModel.findOne({ code });
      exists = !!room;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error('Failed to generate unique room code after maximum attempts');
    }

    return code!;
  } catch (error: any) {
    // Check for MongoDB connection errors
    if (error.name === 'MongoServerSelectionError' || error.name === 'MongoNetworkError') {
      logger.error('MongoDB connection error when generating room code', { 
        error: error.message 
      });
      throw new Error('Database connection not available');
    }
    
    logger.error('Error generating room code', { 
      error: error instanceof Error ? error.message : String(error),
      errorName: error.name,
      errorCode: error.code
    });
    throw error;
  }
};

