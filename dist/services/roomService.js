import mongoose from 'mongoose';
import { RoomModel } from '../models/Room.js';
import { generateRoomCode } from '../utils/roomCode.js';
import { generateToken, verifyToken } from '../utils/jwt.js';
import { generateUniqueSlug, isNumericCode, extractCodeFromSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';
import { recordRoomCreated, recordRoomVanished } from './dailyStatsService.js';
import { incrementGlobalStat } from '../utils/globalStats.js';
import { getSettingsSync } from './adminSettingsService.js';
/**
 * `getRoomByCode` is called on every message send and every join — a burst of
 * either hits Mongo once per call with no caching. Room settings (lock state,
 * slow mode, ownership) change rarely, so a short-TTL cache cuts nearly all of
 * that read traffic. Every mutator below invalidates its room's entry
 * immediately; the TTL is just a safety net for any update path that doesn't
 * go through this file.
 */
const ROOM_CACHE_TTL_MS = 4000;
const roomCache = new Map();
const cacheRoom = (code, room) => {
    roomCache.set(code, { room, expiresAt: Date.now() + ROOM_CACHE_TTL_MS });
};
/**
 * Exported because the room purge path must evict this synchronously. A cached
 * entry outliving its room isn't just stale-read latency: room codes are
 * recycled from a small patterned space, so a purge that leaves the entry
 * behind can serve the previous tenant's room object (ownerId, plan, lock
 * state) to the next room issued that code.
 */
export const invalidateRoomCache = (code) => {
    roomCache.delete(code);
};
/**
 * Wait for database connection to be ready
 * Retries up to 10 times with 500ms delay between attempts (max 5 seconds wait)
 * Handles both disconnected (0) and connecting (2) states
 */
const waitForDatabase = async (maxRetries = 10, delayMs = 500) => {
    for (let i = 0; i < maxRetries; i++) {
        const readyState = mongoose.connection.readyState;
        // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
        if (readyState === 1) {
            return true;
        }
        // If connecting (2), wait for it to complete
        if (readyState === 2) {
            logger.debug('Database is connecting, waiting...', { attempt: i + 1 });
        }
        else if (readyState === 0) {
            logger.debug('Database is disconnected, waiting for connection...', { attempt: i + 1 });
        }
        if (i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return false;
};
export const createRoom = async (data) => {
    // Wait for database connection if not ready (handles cold start scenario)
    if (mongoose.connection.readyState !== 1) {
        logger.debug('Database not ready, waiting for connection...', {
            readyState: mongoose.connection.readyState
        });
        const isReady = await waitForDatabase();
        if (!isReady) {
            logger.error('Database connection not available after waiting');
            throw new Error('Database connection not available');
        }
        logger.debug('Database connection ready, proceeding with room creation');
    }
    try {
        const code = await generateRoomCode();
        const token = generateToken(code);
        // Room lifetime is admin-configurable at runtime (dashboard → Settings).
        // getSettingsSync reads the in-process cache and falls back to
        // env.DEFAULT_ROOM_EXP_HOURS, so behaviour is unchanged when unset.
        const expiryHours = getSettingsSync().defaultRoomExpiryHours;
        const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
        let slug = generateUniqueSlug(data?.name || '', code);
        // Ensure slug uniqueness
        let existing = await RoomModel.findOne({ slug });
        let counter = 1;
        while (existing) {
            slug = generateUniqueSlug(data?.name || '', `${code}-${counter}`);
            existing = await RoomModel.findOne({ slug });
            counter++;
        }
        const room = new RoomModel({
            code,
            token,
            name: data?.name,
            slug,
            isPublic: data?.isPublic || false,
            plan: data?.plan || 'free',
            expiresAt,
            participants: [],
            ownerId: data?.userId,
            ownerUserId: data?.ownerUserId,
        });
        await room.save();
        const roomObject = room.toObject();
        // Room codes are recycled from a small patterned keyspace, so this code
        // may still hold a stale cache entry from whatever room previously held
        // it (purge invalidates on delete, but only closes that race, it doesn't
        // guarantee zero overlap). Overwriting the cache here — with the room we
        // just verified is the sole owner of `code` via the DB's unique index —
        // makes creation self-healing: the very next getRoomByCode read is
        // guaranteed to see this room, never a leftover previous tenant.
        cacheRoom(code, roomObject);
        // Durable counters — Room documents are TTL-deleted a short time after
        // expiry (see Room.ts's expireAfterSeconds index), so "Total Rooms
        // (Lifetime)" and "Rooms Created Today" can't be answered correctly by
        // counting live documents. Fire-and-forget: never block room creation.
        incrementGlobalStat('totalRoomsLifetime').catch(() => { });
        recordRoomCreated().catch(() => { });
        logger.debug('Room created', { code, slug, expiresAt: expiresAt.toISOString() });
        return roomObject;
    }
    catch (error) {
        // Check for Mongoose validation errors
        if (error.name === 'ValidationError') {
            logger.error('Mongoose validation error when creating room', {
                error: error.message,
                errors: error.errors
            });
            throw new Error(`Validation error: ${error.message}`);
        }
        // Check for duplicate key errors
        if (error.code === 11000 || error.name === 'MongoServerError') {
            logger.error('Duplicate key error when creating room', {
                error: error.message,
                keyPattern: error.keyPattern
            });
            // Retry with a fresh code+slug for a duplicate on either field. A
            // duplicate `slug` here can only happen from the same race as a
            // duplicate `code` (slug always embeds the code), so whichever one
            // Mongo happens to report, the fix is identical: try again from
            // scratch rather than surfacing a spurious failure to the client.
            if (error.keyPattern?.code || error.keyPattern?.slug) {
                logger.info('Retrying room creation due to duplicate code/slug', { keyPattern: error.keyPattern });
                return createRoom(data); // Recursive retry
            }
            throw new Error(`Duplicate entry: ${Object.keys(error.keyPattern || {})[0] || 'unknown field'}`);
        }
        logger.error('Error creating room in database', {
            error: error instanceof Error ? error.message : String(error),
            errorName: error.name,
            errorCode: error.code,
            stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
    }
};
export const getRoomByCode = async (code) => {
    const cached = roomCache.get(code);
    if (cached) {
        if (cached.expiresAt > Date.now()) {
            return cached.room;
        }
        // Evict rather than just ignoring it — a stale entry that's only skipped
        // stays in the Map forever, holding a full Room object per code.
        roomCache.delete(code);
    }
    // Wait for database connection if not ready
    if (mongoose.connection.readyState !== 1) {
        const isReady = await waitForDatabase();
        if (!isReady) {
            logger.error('Database connection not available when getting room by code');
            throw new Error('Database connection not available');
        }
    }
    try {
        const room = await RoomModel.findOne({ code });
        if (!room)
            return null;
        const result = room.toObject();
        cacheRoom(code, result);
        return result;
    }
    catch (error) {
        logger.error('Error getting room by code', {
            code,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
};
export const getRoomBySlug = async (slug) => {
    // Check if database is connected
    if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected when getting room by slug');
        throw new Error('Database connection not available');
    }
    try {
        const room = await RoomModel.findOne({ slug });
        if (!room)
            return null;
        return room.toObject();
    }
    catch (error) {
        logger.error('Error getting room by slug', {
            slug,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
};
export const getRoomBySlugOrCode = async (slugOrCode) => {
    // Wait for database connection if not ready
    if (mongoose.connection.readyState !== 1) {
        const isReady = await waitForDatabase();
        if (!isReady) {
            logger.error('Database connection not available when getting room by slug or code');
            throw new Error('Database connection not available');
        }
    }
    try {
        // Try as code first (numeric)
        if (isNumericCode(slugOrCode)) {
            const room = await getRoomByCode(slugOrCode);
            if (room)
                return room;
        }
        // Try as slug
        const room = await getRoomBySlug(slugOrCode);
        if (room)
            return room;
        // Try extracting code from slug format (e.g., "linkchat-team-sync-8321")
        const extractedCode = extractCodeFromSlug(slugOrCode);
        if (extractedCode) {
            return getRoomByCode(extractedCode);
        }
        return null;
    }
    catch (error) {
        logger.error('Error getting room by slug or code', {
            slugOrCode,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
};
export const getPublicRooms = async (limit = 50) => {
    // Check if database is connected
    if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected when getting public rooms');
        throw new Error('Database connection not available');
    }
    try {
        const now = new Date();
        const maxLimit = Math.min(limit, 100); // Cap at 100 rooms
        const rooms = await RoomModel.find({
            isPublic: true,
            expiresAt: { $gt: now },
        })
            .sort({ createdAt: -1 })
            .limit(maxLimit)
            .select('code slug name createdAt expiresAt')
            .lean()
            .exec();
        return rooms;
    }
    catch (error) {
        logger.error('Error getting public rooms', {
            limit,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
};
export const verifyRoomToken = (token, code) => {
    if (!token || !code || typeof token !== 'string' || typeof code !== 'string') {
        return false;
    }
    try {
        const decoded = verifyToken(token);
        return decoded !== null && decoded.roomCode === code;
    }
    catch {
        return false;
    }
};
export const endRoom = async (code, userId) => {
    if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected when ending room');
        throw new Error('Database connection not available');
    }
    try {
        const room = await RoomModel.findOneAndUpdate({ code }, {
            isEnded: true,
            endedAt: new Date(),
            endedBy: userId
        }, { new: true });
        if (!room) {
            throw new Error('Room not found');
        }
        logger.info('Room ended', { code, endedBy: userId });
        invalidateRoomCache(code);
        recordRoomVanished('owner').catch(() => { });
        return room.toObject();
    }
    catch (error) {
        logger.error('Error ending room', {
            code,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
};
export const removeParticipant = async (code, userId) => {
    if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected when removing participant');
        throw new Error('Database connection not available');
    }
    try {
        const room = await RoomModel.findOneAndUpdate({ code }, { $pull: { participants: userId } }, { new: true });
        if (!room) {
            throw new Error('Room not found');
        }
        logger.info('Participant removed from room', { code, userId });
        invalidateRoomCache(code);
        return room.toObject();
    }
    catch (error) {
        logger.error('Error removing participant', {
            code,
            userId,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
};
export const unlockRoom = async (code) => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection not available');
    }
    const room = await RoomModel.findOneAndUpdate({ code }, { isLocked: false, $unset: { lockedAt: '' } }, { new: true });
    if (!room) {
        throw new Error('Room not found');
    }
    logger.info('Room unlocked', { code });
    invalidateRoomCache(code);
    return room.toObject();
};
export const transferRoomOwnership = async (code, newOwnerId) => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection not available');
    }
    const existing = await RoomModel.findOne({ code });
    if (!existing) {
        throw new Error('Room not found');
    }
    const coHostIds = (existing.coHostIds || []).filter((id) => id !== newOwnerId);
    const room = await RoomModel.findOneAndUpdate({ code }, { ownerId: newOwnerId, coHostIds }, { new: true });
    if (!room) {
        throw new Error('Room not found');
    }
    logger.info('Room ownership transferred', { code, newOwnerId });
    invalidateRoomCache(code);
    return room.toObject();
};
export const addRoomCoHost = async (code, userId) => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection not available');
    }
    const room = await RoomModel.findOneAndUpdate({ code }, { $addToSet: { coHostIds: userId } }, { new: true });
    if (!room) {
        throw new Error('Room not found');
    }
    invalidateRoomCache(code);
    return room.toObject();
};
export const removeRoomCoHost = async (code, userId) => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection not available');
    }
    const room = await RoomModel.findOneAndUpdate({ code }, { $pull: { coHostIds: userId } }, { new: true });
    if (!room) {
        throw new Error('Room not found');
    }
    invalidateRoomCache(code);
    return room.toObject();
};
export const setRoomSlowMode = async (code, messagesPerMinute) => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection not available');
    }
    const limit = Math.max(0, Math.min(60, Math.floor(messagesPerMinute)));
    const room = await RoomModel.findOneAndUpdate({ code }, { slowModeMessagesPerMinute: limit }, { new: true });
    if (!room) {
        throw new Error('Room not found');
    }
    invalidateRoomCache(code);
    return room.toObject();
};
export const setParticipantsCanSend = async (code, canSend) => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection not available');
    }
    const room = await RoomModel.findOneAndUpdate({ code }, { participantsCanSend: canSend }, { new: true });
    if (!room) {
        throw new Error('Room not found');
    }
    invalidateRoomCache(code);
    return room.toObject();
};
export const setJoinLocked = async (code, locked) => {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection not available');
    }
    const room = await RoomModel.findOneAndUpdate({ code }, { joinLocked: locked }, { new: true });
    if (!room) {
        throw new Error('Room not found');
    }
    invalidateRoomCache(code);
    return room.toObject();
};
export const lockRoom = async (code) => {
    if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected when locking room');
        throw new Error('Database connection not available');
    }
    try {
        const room = await RoomModel.findOneAndUpdate({ code }, {
            isLocked: true,
            lockedAt: new Date()
        }, { new: true });
        if (!room) {
            throw new Error('Room not found');
        }
        logger.info('Room locked', { code, lockedAt: room.lockedAt });
        invalidateRoomCache(code);
        return room.toObject();
    }
    catch (error) {
        logger.error('Error locking room', {
            code,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
};
//# sourceMappingURL=roomService.js.map