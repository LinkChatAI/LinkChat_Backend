import { createRoom, getRoomBySlugOrCode, endRoom, removeParticipant } from '../services/roomService.js';
import { generateUploadUrl } from '../services/gcsService.js';
import { isFileUploadAvailable } from '../config/gcs.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { validateFileUpload } from '../utils/validation.js';
import { sanitizeName } from '../utils/sanitize.js';
import { generatePairingCodeForRoom, validatePairingCode } from '../services/pairingService.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
const createRoomSchema = z.object({
    name: z.string().max(100).optional(),
    isPublic: z.boolean().optional(),
});
const uploadUrlSchema = z.object({
    fileName: z.string().min(1),
    mimeType: z.string(), // Allow empty string, will be inferred from filename if needed
    fileSize: z.number().positive(),
});
export const createRoomHandler = async (req, res) => {
    try {
        const body = createRoomSchema.parse(req.body);
        const data = {
            name: body.name ? sanitizeName(body.name) : undefined,
            isPublic: body.isPublic || false,
        };
        const room = await createRoom(data);
        logger.info('Room created', { code: room.code, slug: room.slug });
        res.json({
            code: room.code,
            token: room.token,
            slug: room.slug,
            name: room.name,
            expiresAt: room.expiresAt,
        });
    }
    catch (error) {
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
            const mongooseError = error;
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
            errorName: error && typeof error === 'object' && 'name' in error ? error.name : undefined,
            errorCode: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
            stack: error instanceof Error ? error.stack : undefined
        });
        // Return more specific error message
        const errorMessage = error instanceof Error ? error.message : 'Failed to create room';
        res.status(500).json({
            error: errorMessage,
            ...(process.env.NODE_ENV === 'development' && {
                details: error instanceof Error ? error.stack : undefined,
                errorName: error && typeof error === 'object' && 'name' in error ? error.name : undefined
            })
        });
    }
};
export const getRoomHandler = async (req, res) => {
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
            createdAt: room.createdAt,
            expiresAt: room.expiresAt,
            participantCount: room.participants.length,
            fileUploadAvailable: isFileUploadAvailable(),
        });
    }
    catch (error) {
        logger.error('Error getting room', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ error: 'Failed to get room' });
    }
};
export const generateUploadUrlHandler = async (req, res) => {
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
        const sanitizedFileName = validation.sanitizedFileName;
        const mimeType = validation.inferredMimeType || body.mimeType;
        const { uploadUrl, filePath } = await generateUploadUrl(code, sanitizedFileName, mimeType, body.fileSize);
        logger.debug(`Upload URL generated for room ${code}: ${body.fileName}`);
        res.json({ uploadUrl, filePath });
    }
    catch (error) {
        if (error instanceof z.ZodError) {
            logger.warn('Invalid upload URL request body:', error.errors);
            res.status(400).json({ error: 'Invalid request body', details: error.errors });
            return;
        }
        // Handle GCS not configured error specifically
        if (error instanceof Error && error.message === 'GCS not configured') {
            logger.warn('File upload requested but GCS is not configured', { code: req.params.code });
            res.status(503).json({ error: 'File uploads are not available. GCS storage is not configured.' });
            return;
        }
        logger.error('Error generating upload URL:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            code: req.params.code,
        });
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate upload URL' });
    }
};
const pairingCodeSchema = z.object({
    pairingCode: z.string().length(6),
});
export const generatePairingCodeHandler = async (req, res) => {
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
    }
    catch (error) {
        logger.error('Error generating pairing code', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate pairing code' });
    }
};
export const validatePairingCodeHandler = async (req, res) => {
    try {
        const body = pairingCodeSchema.parse(req.body);
        const result = await validatePairingCode(body.pairingCode);
        if (!result) {
            res.status(404).json({ error: 'Invalid or expired pairing code' });
            return;
        }
        logger.info('Pairing code validated', { pairingCode: body.pairingCode });
        res.json(result);
    }
    catch (error) {
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
/**
 * Handle local file upload (fallback when GCS is not configured)
 */
export const uploadLocalFileHandler = async (req, res) => {
    try {
        const { code } = req.params;
        if (req.roomCode !== code) {
            logger.warn(`Unauthorized local upload request for room ${code}`);
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        if (!req.body || !req.body.file || !req.body.fileName) {
            res.status(400).json({ error: 'Missing file data' });
            return;
        }
        const { file: fileDataUrl, fileName, mimeType } = req.body;
        // Extract base64 data
        const matches = fileDataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) {
            res.status(400).json({ error: 'Invalid file format' });
            return;
        }
        const [, , base64Data] = matches;
        const buffer = Buffer.from(base64Data, 'base64');
        // Validate file size
        const validation = validateFileUpload(fileName, mimeType || 'application/octet-stream', buffer.length);
        if (!validation.valid) {
            res.status(400).json({ error: validation.error });
            return;
        }
        // Save to local storage
        const fileId = uuidv4();
        const sanitizedFileName = validation.sanitizedFileName;
        const filePath = `rooms/${code}/${fileId}-${sanitizedFileName}`;
        const fullPath = path.join(process.cwd(), 'uploads', filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, buffer);
        logger.info(`Local file uploaded for room ${code}: ${sanitizedFileName}`);
        res.json({ filePath, url: `/uploads/${filePath}` });
    }
    catch (error) {
        logger.error('Error uploading local file', {
            error: error instanceof Error ? error.message : String(error),
            code: req.params.code,
        });
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to upload file' });
    }
};
export const endRoomHandler = async (req, res) => {
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
    }
    catch (error) {
        logger.error('Error ending room', {
            error: error instanceof Error ? error.message : String(error),
            code: req.params.code,
        });
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to end room' });
    }
};
export const leaveRoomHandler = async (req, res) => {
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
    }
    catch (error) {
        logger.error('Error leaving room', {
            error: error instanceof Error ? error.message : String(error),
            code: req.params.code,
        });
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to leave room' });
    }
};
//# sourceMappingURL=roomController.js.map