import { Request, Response } from 'express';
import { createRoom, getRoomByCode, getRoomBySlugOrCode, endRoom, removeParticipant } from '../services/roomService.js';
import { generateUploadUrl, getFileUrl } from '../services/gcsService.js';
import { isFileUploadAvailable } from '../config/gcs.js';
import { AuthRequest } from '../middleware/auth.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { validateFileUpload } from '../utils/validation.js';
import { CreateRoomRequest } from '../types/index.js';
import { sanitizeName } from '../utils/sanitize.js';
import { generatePairingCodeForRoom, validatePairingCode } from '../services/pairingService.js';
import { v4 as uuidv4 } from 'uuid';
import { getIoInstance } from '../socket/ioInstance.js';
import { emitAdminInsightUpdate } from '../socket/adminHandlers.js';

const createRoomSchema = z.object({
  name: z.string().max(100).optional(),
  isPublic: z.boolean().optional(),
  userId: z.string().uuid().optional(), // UUID of the room creator
});

const uploadUrlSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string(), // Allow empty string, will be inferred from filename if needed
  fileSize: z.number().positive(),
});

export const createRoomHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = createRoomSchema.parse(req.body);
    const data: CreateRoomRequest = {
      name: body.name ? sanitizeName(body.name) : undefined,
      isPublic: body.isPublic || false,
      userId: body.userId, // Pass userId to service
    };
    const room = await createRoom(data);
    logger.info('Room created', { code: room.code, slug: room.slug, ownerId: room.ownerId });
    
    // Emit admin insight update
    const io = getIoInstance();
    if (io) {
      emitAdminInsightUpdate(io, 'room_created', { roomCode: room.code, isPublic: room.isPublic }).catch(err => {
        logger.warn('Failed to emit admin insight update', { error: err instanceof Error ? err.message : String(err) });
      });
    }
    
    res.json({
      code: room.code,
      token: room.token,
      slug: room.slug,
      name: room.name,
      expiresAt: room.expiresAt,
      ownerId: room.ownerId, // Return ownerId to frontend
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid create room request', { errors: error.errors });
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    
    // Handle database connection errors
    if (error instanceof Error && error.message === 'Database connection not available') {
      logger.error('Database not available when creating room');
      res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
      return;
    }
    
    // Handle Mongoose/MongoDB errors
    if (error && typeof error === 'object' && 'name' in error) {
      const mongooseError = error as any;
      if (mongooseError.name === 'MongoServerSelectionError' || mongooseError.name === 'MongoNetworkError') {
        logger.error('MongoDB connection error when creating room', { error: mongooseError.message });
        res.status(503).json({ error: 'Database connection failed. Please check your MongoDB connection string.' });
        return;
      }
      if (mongooseError.name === 'ValidationError') {
        logger.error('Validation error when creating room', { error: mongooseError.message });
        res.status(400).json({ error: `Validation error: ${mongooseError.message}` });
        return;
      }
      if (mongooseError.code === 11000) {
        logger.error('Duplicate key error when creating room', { error: mongooseError.message });
        res.status(409).json({ error: 'Room with this code already exists. Please try again.' });
        return;
      }
    }
    
    // Log the full error for debugging
    logger.error('Error creating room', { 
      error: error instanceof Error ? error.message : String(error),
      errorName: error && typeof error === 'object' && 'name' in error ? (error as any).name : undefined,
      errorCode: error && typeof error === 'object' && 'code' in error ? (error as any).code : undefined,
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Return more specific error message
    const errorMessage = error instanceof Error ? error.message : 'Failed to create room';
    res.status(500).json({ 
      error: errorMessage,
      ...(process.env.NODE_ENV === 'development' && { 
        details: error instanceof Error ? error.stack : undefined,
        errorName: error && typeof error === 'object' && 'name' in error ? (error as any).name : undefined
      })
    });
  }
};

export const getRoomHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slugOrCode } = req.params;
    const room = await getRoomBySlugOrCode(slugOrCode);

    if (!room) {
      logger.warn('Room not found', { slugOrCode });
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    if (new Date() > room.expiresAt) {
      logger.warn('Room expired', { code: room.code });
      res.status(410).json({ error: 'Room expired' });
      return;
    }

    logger.debug('Room details requested', { code: room.code });
    res.json({
      code: room.code,
      slug: room.slug,
      name: room.name,
      ownerId: room.ownerId, // Include ownerId for RBAC
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      participantCount: room.participants.length,
      fileUploadAvailable: isFileUploadAvailable(),
      isLocked: room.isLocked || false,
      lockedAt: room.lockedAt ? room.lockedAt.toISOString() : undefined,
    });
  } catch (error: any) {
    logger.error('Error getting room', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get room' });
  }
};

export const generateUploadUrlHandler = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { code } = req.params;
    if (req.roomCode !== code) {
      logger.warn(`Unauthorized upload URL request for room ${code}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const body = uploadUrlSchema.parse(req.body);
    
    const validation = validateFileUpload(body.fileName, body.mimeType, body.fileSize);
    if (!validation.valid) {
      logger.warn('File validation failed', { code, error: validation.error });
      res.status(400).json({ error: validation.error });
      return;
    }

    const sanitizedFileName = validation.sanitizedFileName!;
    const mimeType = validation.inferredMimeType || body.mimeType;
    
    // Generate upload URL - will throw error if GCS is not configured
    const { uploadUrl, filePath } = await generateUploadUrl(
      code,
      sanitizedFileName,
      mimeType,
      body.fileSize
    );

    logger.debug(`Upload URL generated for room ${code}: ${body.fileName}`);
    res.json({ uploadUrl, filePath });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid upload URL request body:', error.errors);
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    
    // Handle GCS configuration errors (explicit failures from generateUploadUrl)
    if (error instanceof Error) {
      const errorMessage = error.message;
      
      // GCS not configured or initialization failed
      if (errorMessage.includes('GCS is not configured') || 
          errorMessage.includes('GCS client initialization') ||
          errorMessage.includes('Missing environment variables')) {
        logger.error('GCS upload failed - configuration error', {
          error: errorMessage,
          code: req.params.code,
        });
        res.status(503).json({ 
          error: errorMessage,
          code: 'GCS_NOT_CONFIGURED'
        });
        return;
      }
      
      // File size validation errors
      if (errorMessage.includes('File size exceeds maximum')) {
        logger.warn('File size validation failed', { error: errorMessage, code: req.params.code });
        res.status(400).json({ error: errorMessage });
        return;
      }
      
      // GCS API errors (signed URL generation failures)
      if (errorMessage.includes('Failed to generate GCS upload URL')) {
        logger.error('GCS signed URL generation failed', {
          error: errorMessage,
          code: req.params.code,
          stack: error.stack,
        });
        res.status(500).json({ 
          error: 'Failed to generate upload URL. Please check GCS configuration and credentials.',
          code: 'GCS_UPLOAD_URL_ERROR'
        });
        return;
      }
    }
    
    // Unknown errors
    logger.error('Unexpected error generating upload URL:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      code: req.params.code,
    });
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to generate upload URL',
      code: 'UNKNOWN_ERROR'
    });
  }
};

// Public upload handler - allows anyone in the room to upload files
export const generateUploadUrlPublicHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { code } = req.params;
    
    // Verify room exists and is not expired
    const room = await getRoomByCode(code);
    if (!room) {
      logger.warn(`Room ${code} not found for public upload`);
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    if (new Date() > room.expiresAt) {
      logger.warn(`Room ${code} expired for public upload`);
      res.status(410).json({ error: 'Room expired' });
      return;
    }

    const body = uploadUrlSchema.parse(req.body);
    
    const validation = validateFileUpload(body.fileName, body.mimeType, body.fileSize);
    if (!validation.valid) {
      logger.warn('File validation failed', { code, error: validation.error });
      res.status(400).json({ error: validation.error });
      return;
    }

    const sanitizedFileName = validation.sanitizedFileName!;
    const mimeType = validation.inferredMimeType || body.mimeType;
    const { uploadUrl, filePath } = await generateUploadUrl(
      code,
      sanitizedFileName,
      mimeType,
      body.fileSize
    );

    logger.debug(`Public upload URL generated for room ${code}: ${body.fileName}`);
    res.json({ uploadUrl, filePath });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid upload URL request body:', error.errors);
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    
    // Handle GCS configuration errors (explicit failures from generateUploadUrl)
    if (error instanceof Error) {
      const errorMessage = error.message;
      
      // GCS not configured or initialization failed
      if (errorMessage.includes('GCS is not configured') || 
          errorMessage.includes('GCS client initialization') ||
          errorMessage.includes('Missing environment variables')) {
        logger.error('GCS upload failed - configuration error', {
          error: errorMessage,
          code: req.params.code,
        });
        res.status(503).json({ 
          error: errorMessage,
          code: 'GCS_NOT_CONFIGURED'
        });
        return;
      }
      
      // File size validation errors
      if (errorMessage.includes('File size exceeds maximum')) {
        logger.warn('File size validation failed', { error: errorMessage, code: req.params.code });
        res.status(400).json({ error: errorMessage });
        return;
      }
      
      // GCS API errors (signed URL generation failures)
      if (errorMessage.includes('Failed to generate GCS upload URL')) {
        logger.error('GCS signed URL generation failed', {
          error: errorMessage,
          code: req.params.code,
          stack: error.stack,
        });
        res.status(500).json({ 
          error: 'Failed to generate upload URL. Please check GCS configuration and credentials.',
          code: 'GCS_UPLOAD_URL_ERROR'
        });
        return;
      }
    }
    
    // Unknown errors
    logger.error('Unexpected error generating public upload URL:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      code: req.params.code,
    });
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to generate upload URL',
      code: 'UNKNOWN_ERROR'
    });
  }
};

const pairingCodeSchema = z.object({
  pairingCode: z.string().length(6),
});

export const generatePairingCodeHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    const userId = req.body.userId || uuidv4();

    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Invalid room code' });
      return;
    }

    const pairingCode = await generatePairingCodeForRoom(code, userId);
    logger.info('Pairing code generated', { code, pairingCode });
    res.json({ pairingCode });
  } catch (error: any) {
    logger.error('Error generating pairing code', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate pairing code' });
  }
};

export const validatePairingCodeHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = pairingCodeSchema.parse(req.body);
    const result = await validatePairingCode(body.pairingCode);

    if (!result) {
      res.status(404).json({ error: 'Invalid or expired pairing code' });
      return;
    }

    logger.info('Pairing code validated', { pairingCode: body.pairingCode });
    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    logger.error('Error validating pairing code', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to validate pairing code' });
  }
};

export const endRoomHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    const { userId } = req.body;

    if (!code || !userId) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Verify room token
    if (req.roomCode !== code) {
      logger.warn(`Unauthorized end room request for room ${code}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const room = await endRoom(code, userId);
    logger.info(`Room ${code} ended by ${userId}`);
    res.json({ success: true, room });
  } catch (error: any) {
    logger.error('Error ending room', {
      error: error instanceof Error ? error.message : String(error),
      code: req.params.code,
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to end room' });
  }
};

export const leaveRoomHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { code } = req.params;
    const { userId } = req.body;

    if (!code || !userId) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const room = await removeParticipant(code, userId);
    logger.info(`User ${userId} left room ${code}`);
    res.json({ success: true, room });
  } catch (error: any) {
    logger.error('Error leaving room', {
      error: error instanceof Error ? error.message : String(error),
      code: req.params.code,
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to leave room' });
  }
};

