import { Server, Socket } from 'socket.io';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { getRoomByCode, verifyRoomToken, lockRoom } from '../services/roomService.js';
import { createMessage, getRoomMessages, getMessagesAfterId, deleteMessage, addReaction, removeReaction, editMessage, pinMessage, unpinMessage, searchMessages, getPinnedMessages } from '../services/messageService.js';
import { getFileUrl, getDownloadUrl, getImageUrl, deleteRoomFiles } from '../services/gcsService.js';
import { SocketUser, Message } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { validateMessageSize, validateFileSize, validateMimeType } from '../utils/validation.js';
import { logger } from '../utils/logger.js';
import { socketRateLimiter } from '../middleware/rateLimiter.js';
import { sanitizeName, sanitizeText } from '../utils/sanitize.js';
import mongoose from 'mongoose';
import { MessageModel } from '../models/Message.js';
import { RoomModel } from '../models/Room.js';
import { emitAdminInsightUpdate } from './adminHandlers.js';

const getRedis = () => getRedisClient();

// Helper function to normalize message type for frontend consistency
// Messages stored as 'file' in DB with image mimeType should be normalized to 'image'
// This prevents UI flicker when loading messages from database
const normalizeMessageType = (message: Message): Message => {
  if (message.type === 'file' && message.fileMeta?.mimeType && message.fileMeta.mimeType.startsWith('image/')) {
    return { ...message, type: 'image' as any };
  }
  return message;
};

// Helper function to normalize an array of messages
const normalizeMessages = (messages: Message[]): Message[] => {
  return messages.map(normalizeMessageType);
};

export const handleSocketConnection = (io: Server, socket: Socket): void => {
  // Initialize userId from socket auth (persistent UUID from localStorage) or fallback
  const authUserId = socket.handshake.auth?.userId;
  const user: SocketUser = {
    userId: (authUserId && typeof authUserId === 'string' && authUserId.trim()) ? authUserId.trim() : uuidv4(),
    nickname: socket.handshake.auth?.nickname || 'Anonymous',
    roomCode: '',
  };
  
  const typingUsers = new Map<string, NodeJS.Timeout>();

  // Helper function to ensure nickname is unique in room by checking active sockets, Redis, and MongoDB
  const ensureNicknameUniqueInRoom = async (baseNickname: string, roomCode: string, excludeUserId: string, io: Server): Promise<string> => {
    const existingNicknames = new Set<string>();
    
    // 1. Check all active sockets in the room (real-time users)
    try {
      const socketsInRoom = await io.in(roomCode).fetchSockets();
      for (const socketInRoom of socketsInRoom) {
        const socketData = (socketInRoom as any).data;
        if (socketData?.user) {
          const socketUser = socketData.user as SocketUser;
          // Skip the excluded userId (user refreshing with same nickname)
          if (socketUser.userId !== excludeUserId && socketUser.nickname && socketUser.nickname !== 'Anonymous') {
            existingNicknames.add(socketUser.nickname.toLowerCase());
          }
        }
      }
    } catch (error: any) {
      logger.warn('Failed to check active sockets for nicknames', { error: error instanceof Error ? error.message : String(error) });
    }
    
    // 2. Check Redis for nicknames (covers users who may have disconnected but are still in Redis)
    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      try {
        const userIds = await redis.smembers(`room:${roomCode}:users`);
        if (userIds && userIds.length > 0) {
          for (const userId of userIds) {
            if (userId !== excludeUserId) {
              const storedNickname = await redis.hget(`user:${userId}`, 'nickname');
              if (storedNickname && storedNickname !== 'Anonymous') {
                existingNicknames.add(storedNickname.toLowerCase());
              }
            }
          }
        }
      } catch (error: any) {
        logger.warn('Failed to check Redis for nicknames', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    
    // 3. Check MongoDB messages for historical nicknames in this room
    try {
      const { MessageModel } = await import('../models/Message.js');
      const query: any = { roomCode };
      if (excludeUserId) {
        query.userId = { $ne: excludeUserId };
      }
      const distinctNicknames = await MessageModel.distinct('nickname', query).exec();
      distinctNicknames.forEach((nickname: any) => {
        if (nickname && typeof nickname === 'string' && nickname.trim() !== 'Anonymous') {
          existingNicknames.add(nickname.trim().toLowerCase());
        }
      });
    } catch (error: any) {
      logger.warn('Failed to check MongoDB for nicknames', { error: error instanceof Error ? error.message : String(error) });
    }
    
    const baseLower = baseNickname.toLowerCase();
    
    // If nickname is already unique, return as-is
    if (!existingNicknames.has(baseLower)) {
      return baseNickname;
    }
    
    // Nickname exists, append 3-digit suffix (e.g., "Ghost#839")
    let attempts = 0;
    const maxAttempts = 20; // Increased attempts for better uniqueness
    while (attempts < maxAttempts) {
      const suffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      const uniqueNickname = `${baseNickname}#${suffix}`;
      
      if (!existingNicknames.has(uniqueNickname.toLowerCase())) {
        logger.debug('Nickname conflict resolved with suffix', {
          original: baseNickname,
          unique: uniqueNickname,
          roomCode,
          excludeUserId,
        });
        return uniqueNickname;
      }
      attempts++;
    }
    
    // Fallback: use timestamp-based suffix (guaranteed unique)
    const timestampSuffix = Date.now().toString().slice(-3);
    const uniqueNickname = `${baseNickname}#${timestampSuffix}`;
    logger.warn('Used timestamp suffix for nickname uniqueness after max attempts', {
      original: baseNickname,
      unique: uniqueNickname,
      roomCode,
      attempts: maxAttempts,
    });
    return uniqueNickname;
  };

  socket.on('joinRoom', async (data: { code: string; nickname?: string; senderId?: string }) => {
    try {
      // Validate input
      if (!data || typeof data.code !== 'string' || !data.code.trim()) {
        logger.warn('Invalid joinRoom request', { data });
        socket.emit('error', { message: 'Invalid room code' });
        return;
      }

      const code = data.code.trim();
      
      // Validate code format (should be numeric)
      if (!/^\d+$/.test(code)) {
        logger.warn('Invalid room code format', { code });
        socket.emit('error', { message: 'Invalid room code format' });
        return;
      }

      // Use senderId from client (persistent UUID) if provided
      if (data.senderId && typeof data.senderId === 'string' && data.senderId.trim()) {
        user.userId = data.senderId.trim();
      }

      // Validate room exists BEFORE checking nickname uniqueness
      logger.debug(`User ${user.userId} attempting to join room ${code}`);
      const room = await getRoomByCode(code);
      if (!room) {
        logger.warn(`Room ${code} not found`);
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      if (new Date() > room.expiresAt) {
        logger.warn(`Room ${code} expired`);
        socket.emit('error', { message: 'Room expired' });
        return;
      }

      // Determine nickname: use provided nickname if available, otherwise generate unique one for room
      // IMPORTANT: Check uniqueness AFTER room validation but BEFORE joining the room
      let nickname: string;
      if (data.nickname && typeof data.nickname === 'string' && data.nickname.trim()) {
        // User provided nickname (e.g., from localStorage) - sanitize and ensure uniqueness
        const providedNickname = sanitizeName(data.nickname.trim());
        // Check for conflicts: active sockets, Redis, and MongoDB messages
        nickname = await ensureNicknameUniqueInRoom(providedNickname, code, user.userId, io);
        if (nickname !== providedNickname) {
          logger.info('Provided nickname had conflict, appended suffix', {
            original: providedNickname,
            unique: nickname,
            roomCode: code,
            userId: user.userId,
          });
        }
      } else {
        // No nickname provided - generate unique one for this room
        try {
          const { generateUniqueNicknameForRoom } = await import('../utils/nickname.js');
          let baseNickname = await generateUniqueNicknameForRoom(code);
          // Double-check against all sources (sockets, Redis, MongoDB)
          nickname = await ensureNicknameUniqueInRoom(baseNickname, code, user.userId, io);
          logger.debug('Generated unique nickname for room', { nickname, roomCode: code, userId: user.userId });
        } catch (error: any) {
          // Fallback if generation fails
          logger.warn('Failed to generate unique nickname, using Anonymous', {
            error: error instanceof Error ? error.message : String(error),
            roomCode: code,
          });
          nickname = 'Anonymous';
        }
      }
      
      user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}&background=2563eb&color=fff`;

      // Leave previous room if in one
      if (user.roomCode && user.roomCode !== code) {
        socket.leave(user.roomCode);
      }

      user.roomCode = code;
      user.nickname = nickname;
      // Store user data in socket for nickname conflict checking
      (socket as any).data = { user };
      socket.join(code);

      // Try to update Redis if available
      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.sadd(`room:${data.code}:users`, user.userId);
          await redis.hset(`user:${user.userId}`, {
            nickname: user.nickname,
            roomCode: data.code,
          });
        } catch (error: any) {
          // Ignore Redis errors, continue without it
        }
      }

      const messages = await getRoomMessages(code);
      // Normalize message types for frontend consistency (convert 'file' with image mimeType to 'image')
      const normalizedMessages = normalizeMessages(messages);
      socket.emit('roomJoined', { 
        messages: normalizedMessages, 
        userId: user.userId, 
        nickname: user.nickname,
        isLocked: room.isLocked || false,
        lockedAt: room.lockedAt ? room.lockedAt.toISOString() : undefined
      });
      socket.to(code).emit('userJoined', { userId: user.userId, nickname: user.nickname });

      // Get user count from Redis or use socket.io room size
      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${code}:users`);
        } catch (error: any) {
          // Fallback to socket.io room size
          userCount = io.sockets.adapter.rooms.get(code)?.size || 0;
        }
      } else {
        userCount = io.sockets.adapter.rooms.get(code)?.size || 0;
      }
      io.to(code).emit('userCount', { count: userCount });
      logger.info(`User ${user.userId} joined room ${code}`);
      
      // Emit admin insight update for user join
      emitAdminInsightUpdate(io, 'user_joined', { roomCode: code, userId: user.userId }).catch(err => {
        logger.warn('Failed to emit admin insight update for user join', { error: err instanceof Error ? err.message : String(err) });
      });
    } catch (error: any) {
      logger.error('Error joining room:', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      socket.emit('error', { 
        message: error instanceof Error ? error.message : 'Failed to join room' 
      });
    }
  });

  // Update nickname handler
  socket.on('update_nickname', async (data: { newName: string }) => {
    try {
      // Validate user is in a room
      if (!ensureUserInRoom()) {
        socket.emit('error_alert', { message: 'Not in a room' });
        return;
      }

      // Validate input
      if (!data || typeof data.newName !== 'string' || !data.newName.trim()) {
        socket.emit('error_alert', { message: 'Invalid nickname' });
        return;
      }

      // Validate nickname format: 3-15 characters, alphanumeric only
      const newName = data.newName.trim();
      if (newName.length < 3 || newName.length > 15) {
        socket.emit('error_alert', { message: 'Nickname must be 3-15 characters' });
        return;
      }

      if (!/^[a-zA-Z0-9]+$/.test(newName)) {
        socket.emit('error_alert', { message: 'Nickname must contain only letters and numbers' });
        return;
      }

      // Sanitize nickname
      const sanitizedNickname = sanitizeName(newName);
      
      // Check uniqueness in room (exclude current user)
      const uniqueNickname = await ensureNicknameUniqueInRoom(sanitizedNickname, user.roomCode, user.userId, io);
      
      const oldNickname = user.nickname;
      user.nickname = uniqueNickname;
      user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(uniqueNickname)}&background=2563eb&color=fff`;
      // Update socket data
      (socket as any).data = { user };

      // Update Redis if available
      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.hset(`user:${user.userId}`, {
            nickname: user.nickname,
            roomCode: user.roomCode,
          });
        } catch (error: any) {
          // Ignore Redis errors, continue without it
          logger.warn('Failed to update nickname in Redis', { error });
        }
      }

      // Update all messages in the room from this user
      const { MessageModel } = await import('../models/Message.js');
      try {
        await MessageModel.updateMany(
          { roomCode: user.roomCode, userId: user.userId },
          { $set: { nickname: uniqueNickname, avatar: user.avatar } }
        );
      } catch (error: any) {
        logger.warn('Failed to update messages with new nickname', { error });
      }

      // Broadcast the update to all clients in the room (including sender)
      io.to(user.roomCode).emit('room_user_updated', {
        userId: user.userId,
        nickname: uniqueNickname,
        avatar: user.avatar,
      });

      logger.info(`User ${user.userId} updated nickname from "${oldNickname}" to "${uniqueNickname}" in room ${user.roomCode}`);
    } catch (error: any) {
      emitErrorAlert(error, 'Failed to update nickname');
    }
  });

  // Helper function to check if user has joined a room (race condition prevention)
  const ensureUserInRoom = (): boolean => {
    if (!user.roomCode || user.roomCode.trim() === '') {
      return false;
    }
    // Check if socket is actually in the room
    const room = io.sockets.adapter.rooms.get(user.roomCode);
    return room ? room.has(socket.id) : false;
  };

  // Helper function to emit error alerts
  const emitErrorAlert = (error: any, defaultMessage: string) => {
    const errorMessage = error instanceof Error ? error.message : defaultMessage;
    logger.error(defaultMessage, {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      userId: user.userId,
      roomCode: user.roomCode,
    });
    socket.emit('error_alert', { message: errorMessage });
    socket.emit('error', { message: errorMessage });
  };

  // Sync messages handler (catch-up mechanism)
  socket.on('sync_messages', async (data: { lastMessageId?: string }, ack?: (response: { success: boolean; messages?: Message[]; error?: string }) => void) => {
    try {
      // Validate user is in a room
      if (!ensureUserInRoom()) {
        const errorMsg = 'Not in a room';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      // Validate input
      if (data && data.lastMessageId && typeof data.lastMessageId !== 'string') {
        const errorMsg = 'Invalid lastMessageId format';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const messages = await getMessagesAfterId(user.roomCode, data?.lastMessageId);
      // Normalize message types for frontend consistency (convert 'file' with image mimeType to 'image')
      const normalizedMessages = normalizeMessages(messages);
      socket.emit('messages_synced', { messages: normalizedMessages });
      
      if (ack) {
        ack({ success: true, messages: normalizedMessages });
      }
      
      logger.debug(`Synced ${messages.length} messages for user ${user.userId} in room ${user.roomCode}`);
    } catch (error: any) {
      emitErrorAlert(error, 'Failed to sync messages');
      if (ack) {
        ack({ success: false, error: error instanceof Error ? error.message : 'Failed to sync messages' });
      }
    }
  });

  socket.on('sendMessage', async (data: { content: string; type?: 'text' | 'file' | 'image'; fileKey?: string; fileMeta?: any; replyTo?: string }, ack?: (response: { success: boolean; messageId?: string; error?: string }) => void) => {
    try {
      // Race condition prevention: Ensure user has fully joined the room
      if (!ensureUserInRoom()) {
        const errorMsg = 'Not in a room. Please join a room first.';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      // Check if room is locked (Case 2: Admin left, 24h locked state)
      const room = await getRoomByCode(user.roomCode);
      if (room?.isLocked) {
        const errorMsg = 'Room is locked. No new messages can be sent.';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      // Validate input
      if (!data || typeof data !== 'object') {
        const errorMsg = 'Invalid message data';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      if (typeof data.content !== 'string' || data.content.trim() === '') {
        const errorMsg = 'Message content cannot be empty';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      // Validate roomCode is a string
      if (typeof user.roomCode !== 'string' || !user.roomCode.trim()) {
        const errorMsg = 'Invalid room code';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      // For data URL messages, preserve the full content (don't sanitize data URLs)
      const isDataUrlMessage = data.content.includes('[File:') && data.content.includes('](data:');
      const content = isDataUrlMessage 
        ? data.content.trim() // Only trim whitespace, don't sanitize data URLs
        : sanitizeText(data.content);
      
      if (!content || content.trim() === '') {
        const errorMsg = 'Message cannot be empty after sanitization';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }
      
      logger.debug('Processing message', {
        isDataUrl: isDataUrlMessage,
        contentLength: content.length,
        userId: user.userId,
        roomCode: user.roomCode,
      });

      // Rate limit: 30 messages per minute
      const allowed = await socketRateLimiter(socket.id, 'sendMessage', 30, 60000);
      if (!allowed) {
        const errorMsg = 'Too many messages. Please slow down.';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const validation = validateMessageSize(content);
      if (!validation.valid) {
        logger.warn(`Message size validation failed for user ${user.userId}: ${validation.error}`);
        const errorMsg = validation.error || 'Message validation failed';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const avatar = user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.nickname)}&background=2563eb&color=fff`;
      
      let message;
      
      // Handle file message (with fileKey from GCS upload)
      // Accept both 'file' and 'image' types - both are stored as 'file' in DB
      // but 'image' type is preserved in the emitted message for frontend consistency
      if ((data.type === 'file' || data.type === 'image') && data.fileKey && data.fileMeta) {
        // Validate fileMeta structure
        if (!data.fileMeta || typeof data.fileMeta !== 'object' || 
            typeof data.fileMeta.name !== 'string' || 
            typeof data.fileMeta.size !== 'number' ||
            typeof data.fileMeta.mimeType !== 'string') {
          const errorMsg = 'Invalid file metadata';
          socket.emit('error_alert', { message: errorMsg });
          if (ack) ack({ success: false, error: errorMsg });
          return;
        }

        // IDEMPOTENCY CHECK: Prevent duplicate message creation for the same file
        // Check if a message with this fileKey already exists (within last 10 seconds)
        const recentDuplicate = await MessageModel.findOne({
          roomCode: user.roomCode,
          userId: user.userId,
          type: 'file',
          'fileMeta.name': data.fileMeta.name,
          createdAt: { $gte: new Date(Date.now() - 10000) } // Last 10 seconds
        }).lean().exec();
        
        if (recentDuplicate) {
          logger.debug('Duplicate file message prevented', {
            messageId: recentDuplicate.id,
            fileName: data.fileMeta.name,
            userId: user.userId,
          });
          // Return existing message instead of creating duplicate
          const existingMessage = normalizeMessageType(recentDuplicate);
          io.to(user.roomCode).emit('newMessage', existingMessage);
          if (ack) ack({ success: true, messageId: existingMessage.id });
          return;
        }

        // Get file URL from GCS
        const { getFileUrl, getImageUrl } = await import('../services/gcsService.js');
        const isImage = data.fileMeta.mimeType && data.fileMeta.mimeType.startsWith('image/');
        
        let fileUrl: string;
        try {
          if (isImage) {
            fileUrl = await getImageUrl(data.fileKey);
          } else {
            fileUrl = await getFileUrl(data.fileKey);
          }
        } catch (gcsError: any) {
          logger.error('Error getting file URL:', {
            error: gcsError instanceof Error ? gcsError.message : String(gcsError),
            stack: gcsError instanceof Error ? gcsError.stack : undefined
          });
          const errorMsg = 'File storage error. Could not retrieve file URL.';
          socket.emit('error_alert', { message: errorMsg });
          if (ack) ack({ success: false, error: errorMsg });
          return;
        }
        
        // Create message with file metadata
        // Store as 'file' in DB (schema only supports 'text' | 'file')
        // But preserve the original type for frontend consistency (important for preventing UI flicker)
        const dbType: 'text' | 'file' = 'file'; // Always store as 'file' in DB
        message = await createMessage(
          user.roomCode,
          user.userId,
          user.nickname,
          content,
          dbType,
          {
            name: data.fileMeta.name,
            size: data.fileMeta.size,
            url: fileUrl,
            mimeType: data.fileMeta.mimeType,
          },
          data.replyTo,
          avatar
        );
        
        // CRITICAL: Preserve 'image' type in emitted message for frontend
        // This ensures the optimistic message (type='image') matches the server message
        // preventing UI flicker when the message is confirmed
        if (data.type === 'image' || (data.fileMeta.mimeType && data.fileMeta.mimeType.startsWith('image/'))) {
          message.type = 'image' as any; // Type assertion needed since DB returns 'file'
        }
      } else {
        // Handle text message
        // IDEMPOTENCY CHECK: Prevent duplicate text messages (same content, user, within 5 seconds)
        const recentTextDuplicate = await MessageModel.findOne({
          roomCode: user.roomCode,
          userId: user.userId,
          type: 'text',
          content: content,
          createdAt: { $gte: new Date(Date.now() - 5000) } // Last 5 seconds
        }).lean().exec();
        
        if (recentTextDuplicate) {
          logger.debug('Duplicate text message prevented', {
            messageId: recentTextDuplicate.id,
            content: content.substring(0, 50),
            userId: user.userId,
          });
          // Return existing message instead of creating duplicate
          const existingMessage = normalizeMessageType(recentTextDuplicate);
          io.to(user.roomCode).emit('newMessage', existingMessage);
          if (ack) ack({ success: true, messageId: existingMessage.id });
          return;
        }
        
        message = await createMessage(
          user.roomCode,
          user.userId,
          user.nickname,
          content,
          'text',
          undefined,
          data.replyTo,
          avatar
        );
      }
      
      io.to(user.roomCode).emit('newMessage', message);
      logger.debug(`Message sent in room ${user.roomCode} by user ${user.userId}`, {
        messageId: message.id,
        hasFile: data.type === 'file' || data.type === 'image' || content.includes('[File:'),
        contentLength: content.length,
      });
      
      // Emit admin insight update for file uploads (real-time storage update)
      if ((data.type === 'file' || data.type === 'image') && data.fileMeta?.size) {
        emitAdminInsightUpdate(io, 'file_uploaded', { 
          roomCode: user.roomCode, 
          fileSize: data.fileMeta.size 
        }).catch(err => {
          logger.warn('Failed to emit admin insight update for file upload', { 
            error: err instanceof Error ? err.message : String(err) 
          });
        });
      }
      
      // Send acknowledgment
      if (ack) {
        ack({ success: true, messageId: message.id });
      }
    } catch (error: any) {
      emitErrorAlert(error, 'Error sending message');
      if (ack) {
        ack({ success: false, error: error instanceof Error ? error.message : 'Failed to send message' });
      }
    }
  });

  // Shared helper function for leaving a room (used by both leaveRoom and disconnect)
  const handleUserLeaveRoom = async (roomCodeToLeave: string, userId: string, shouldEmitRoomLeft: boolean = true): Promise<void> => {
    if (!roomCodeToLeave || !roomCodeToLeave.trim()) {
      return;
    }

    try {
      const redis = getRedis();
      
      // 1. Clean up Redis
      if (redis && isRedisAvailable()) {
        try {
          await redis.srem(`room:${roomCodeToLeave}:users`, userId);
          await redis.del(`user:${userId}`);
        } catch (error: any) {
          logger.warn('Redis cleanup error during leave room', {
            error: error instanceof Error ? error.message : String(error),
            roomCode: roomCodeToLeave,
            userId,
          });
        }
      }

      // 2. Leave the socket room
      socket.leave(roomCodeToLeave);

      // 3. Broadcast user left to other participants
      socket.to(roomCodeToLeave).emit('user_left', { userId, roomId: roomCodeToLeave });

      // 4. Update and broadcast user count
      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${roomCodeToLeave}:users`);
        } catch (error: any) {
          userCount = io.sockets.adapter.rooms.get(roomCodeToLeave)?.size || 0;
        }
      } else {
        userCount = io.sockets.adapter.rooms.get(roomCodeToLeave)?.size || 0;
      }
      io.to(roomCodeToLeave).emit('userCount', { count: userCount });

      // 5. Emit roomLeft confirmation if requested (for manual leave, not disconnect)
      if (shouldEmitRoomLeft) {
        socket.emit('roomLeft', { roomId: roomCodeToLeave });
      }

      logger.info(`User ${userId} left room ${roomCodeToLeave}`);
      
      // Emit admin insight update for user leave (only for manual leaves, not disconnects)
      if (shouldEmitRoomLeft) {
        emitAdminInsightUpdate(io, 'user_left', { roomCode: roomCodeToLeave, userId }).catch(err => {
          logger.warn('Failed to emit admin insight update for user leave', { error: err instanceof Error ? err.message : String(err) });
        });
      }
    } catch (error: any) {
      logger.error('Error in handleUserLeaveRoom', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: roomCodeToLeave,
        userId,
      });
      throw error;
    }
  };

  socket.on('leave_room', async (data: { roomId: string }) => {
    // Validate input
    if (!data || typeof data.roomId !== 'string' || !data.roomId.trim()) {
      socket.emit('error', { message: 'Invalid room ID' });
      return;
    }

    const roomId = data.roomId.trim();
    
    // Verify user is in this room
    if (!user.roomCode || user.roomCode !== roomId) {
      socket.emit('error', { message: 'Not in the specified room' });
      return;
    }

    try {
      // Case 2: Check if leaving user is the admin (ownerId)
      const authUserId = socket.handshake.auth?.userId || user.userId;
      const room = await getRoomByCode(roomId);
      
      if (room && room.ownerId && room.ownerId === authUserId && !room.isLocked && !room.isEnded) {
        // Admin is leaving without ending - lock the room for 24h
        logger.info(`Admin ${authUserId} leaving room ${roomId} - locking room for 24h`);
        
        // Lock the room
        await lockRoom(roomId);
        
        // Broadcast system message about locked state
        try {
          const systemMessage = await createMessage(
            roomId,
            'system',
            'System',
            'Admin has left. Room locked. Auto-vanish in 24h.',
            'text'
          );
          io.to(roomId).emit('newMessage', systemMessage);
          logger.info(`Broadcast system message for locked room ${roomId}`);
        } catch (msgError: any) {
          logger.warn('Failed to broadcast system message (non-critical)', {
            error: msgError instanceof Error ? msgError.message : String(msgError),
          });
        }
        
        // Emit room_locked event to all clients
        io.to(roomId).emit('room_locked', {
          roomId,
          lockedAt: new Date().toISOString(),
        });
        
        // Emit admin insight update for room locked
        emitAdminInsightUpdate(io, 'room_locked', { roomCode: roomId }).catch(err => {
          logger.warn('Failed to emit admin insight update for room locked', { error: err instanceof Error ? err.message : String(err) });
        });
      }
      
      await handleUserLeaveRoom(roomId, user.userId, true);
      user.roomCode = ''; // Clear user's room code
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  // Legacy handler for backward compatibility
  socket.on('leaveRoom', async () => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    try {
      await handleUserLeaveRoom(user.roomCode, user.userId, true);
      user.roomCode = '';
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  // Delete Message Handler - with strict permission checks
  socket.on('deleteMessage', async (data: { messageId: string; roomId?: string }) => {
    try {
      if (!ensureUserInRoom()) {
        socket.emit('error_alert', { message: 'Not in a room' });
        return;
      }

      // Validate input
      if (!data || typeof data !== 'object' || typeof data.messageId !== 'string' || !data.messageId.trim()) {
        socket.emit('error_alert', { message: 'Invalid message ID' });
        return;
      }

      const messageId = data.messageId.trim();
      const roomId = data.roomId?.trim() || user.roomCode;

      // 1. Fetch the Message and the Room from MongoDB
      const message = await MessageModel.findOne({ id: messageId });
      if (!message) {
        socket.emit('error_alert', { message: 'Message not found' });
        return;
      }

      const room = await getRoomByCode(roomId);
      if (!room) {
        socket.emit('error_alert', { message: 'Room not found' });
        return;
      }

      // 2. Permission Check: Allow deletion ONLY if:
      //    - socket.userId === message.userId (User deleting own message)
      //    - OR socket.userId === room.ownerId (Admin deleting any message)
      const authUserId = socket.handshake.auth?.userId || user.userId;
      const isAdmin = room.ownerId && room.ownerId === authUserId;
      const isOwnMessage = message.userId === authUserId;
      const canDelete = isOwnMessage || isAdmin;

      if (!canDelete) {
        logger.warn(`Unauthorized message deletion attempt: message.userId=${message.userId}, auth.userId=${authUserId}, room.ownerId=${room.ownerId}, requester=${user.userId}`);
        socket.emit('error_alert', { message: 'Unauthorized: You can only delete your own messages' });
        return;
      }

      // 3. Action: 
      //    - If admin deleting any message: Mark as deletedByAdmin (soft delete)
      //    - If user deleting own message: Hard delete (remove from DB)
      if (isAdmin && !isOwnMessage) {
        // Admin deleting another user's message: soft delete with placeholder
        // Clear fileMeta and update content to placeholder
        const result = await MessageModel.updateOne(
          { id: messageId },
          { 
            $set: { 
              deletedByAdmin: true, 
              content: '[Message deleted by admin]',
              type: 'text' // Change type to text since file is no longer accessible
            },
            $unset: { fileMeta: '' } // Remove file metadata
          }
        );
        
          if (result.modifiedCount > 0) {
          // Fetch updated message to broadcast
          const updatedMessage = await MessageModel.findOne({ id: messageId }).lean();
          // 4. Broadcast: Emit message_deleted event with updated message
          io.to(roomId).emit('messageDeleted', { 
            messageId,
            deletedByAdmin: true,
            message: updatedMessage ? {
              ...updatedMessage,
              deletedByAdmin: true,
              content: '[Message deleted by admin]'
            } : undefined
          });
          logger.info(`Message ${messageId} deleted by admin ${authUserId} in room ${roomId}`);
          
          // Emit admin insight update for file deletions by admin (real-time storage update)
          if (message.type === 'file' && message.fileMeta?.size) {
            emitAdminInsightUpdate(io, 'file_deleted', { 
              roomCode: roomId, 
              fileSize: message.fileMeta.size 
            }).catch(err => {
              logger.warn('Failed to emit admin insight update for file deletion by admin', { 
                error: err instanceof Error ? err.message : String(err) 
              });
            });
          }
        } else {
          socket.emit('error_alert', { message: 'Failed to delete message' });
        }
      } else {
        // User deleting own message: hard delete
        const result = await MessageModel.deleteOne({ id: messageId });
        
        if (result.deletedCount > 0) {
          // 4. Broadcast: Emit message_deleted event to the room
          io.to(roomId).emit('messageDeleted', { messageId, deletedByAdmin: false });
          logger.info(`Message ${messageId} deleted by user ${authUserId} in room ${roomId}`);
          
          // Emit admin insight update for file deletions (real-time storage update)
          if (message.type === 'file' && message.fileMeta?.size) {
            emitAdminInsightUpdate(io, 'file_deleted', { 
              roomCode: roomId, 
              fileSize: message.fileMeta.size 
            }).catch(err => {
              logger.warn('Failed to emit admin insight update for file deletion', { 
                error: err instanceof Error ? err.message : String(err) 
              });
            });
          }
        } else {
          socket.emit('error_alert', { message: 'Failed to delete message' });
        }
      }
    } catch (error: any) {
      emitErrorAlert(error, 'Error deleting message');
    }
  });

  socket.on('addReaction', async (data: { messageId: string; emoji: string }) => {
    try {
      if (!ensureUserInRoom()) {
        socket.emit('error_alert', { message: 'Not in a room' });
        return;
      }

      // Validate input
      if (!data || typeof data !== 'object' ||
          typeof data.messageId !== 'string' || 
          !data.messageId.trim() ||
          typeof data.emoji !== 'string' || 
          !data.emoji.trim()) {
        socket.emit('error_alert', { message: 'Invalid reaction data' });
        return;
      }

      // Validate emoji (basic check - should be a single emoji or short string)
      const emoji = data.emoji.trim();
      if (emoji.length > 10) {
        socket.emit('error_alert', { message: 'Invalid emoji' });
        return;
      }

      const message = await addReaction(data.messageId.trim(), user.userId, emoji);
      if (message) {
        io.to(user.roomCode).emit('reactionAdded', {
          messageId: data.messageId.trim(),
          emoji,
          userId: user.userId,
        });
      } else {
        socket.emit('error_alert', { message: 'Message not found' });
      }
    } catch (error: any) {
      emitErrorAlert(error, 'Error adding reaction');
    }
  });

  socket.on('removeReaction', async (data: { messageId: string; emoji: string }) => {
    try {
      if (!ensureUserInRoom()) {
        socket.emit('error_alert', { message: 'Not in a room' });
        return;
      }

      // Validate input
      if (!data || typeof data !== 'object' ||
          typeof data.messageId !== 'string' || 
          !data.messageId.trim() ||
          typeof data.emoji !== 'string' || 
          !data.emoji.trim()) {
        socket.emit('error_alert', { message: 'Invalid reaction data' });
        return;
      }

      const emoji = data.emoji.trim();
      if (emoji.length > 10) {
        socket.emit('error_alert', { message: 'Invalid emoji' });
        return;
      }

      const message = await removeReaction(data.messageId.trim(), user.userId, emoji);
      if (message) {
        io.to(user.roomCode).emit('reactionRemoved', {
          messageId: data.messageId.trim(),
          emoji,
          userId: user.userId,
        });
      } else {
        socket.emit('error_alert', { message: 'Message not found' });
      }
    } catch (error: any) {
      emitErrorAlert(error, 'Error removing reaction');
    }
  });

  socket.on('typing', () => {
    if (!user.roomCode) return;
    socket.to(user.roomCode).emit('userTyping', { userId: user.userId, nickname: user.nickname });
    const key = `${user.roomCode}:${user.userId}`;
    if (typingUsers.has(key)) clearTimeout(typingUsers.get(key)!);
    typingUsers.set(key, setTimeout(() => {
      socket.to(user.roomCode).emit('userStoppedTyping', { userId: user.userId });
      typingUsers.delete(key);
    }, 3000));
  });

  // Edit Message Handler - with strict permission checks
  socket.on('editMessage', async (data: { messageId: string; roomId?: string; newContent: string }) => {
    try {
      if (!ensureUserInRoom()) {
        socket.emit('error_alert', { message: 'Not in a room' });
        return;
      }
      
      // Validate input
      if (!data || typeof data !== 'object' || typeof data.messageId !== 'string' || typeof data.newContent !== 'string') {
        socket.emit('error_alert', { message: 'Invalid edit data' });
        return;
      }
      
      const messageId = data.messageId.trim();
      const newContent = sanitizeText(data.newContent);
      
      if (!newContent || newContent.trim() === '') {
        socket.emit('error_alert', { message: 'Message cannot be empty' });
        return;
      }

      // 1. Fetch the Message
      const message = await MessageModel.findOne({ id: messageId });
      if (!message) {
        socket.emit('error_alert', { message: 'Message not found' });
        return;
      }

      // 2. Permission Check: Allow update ONLY if socket.userId === message.userId
      // (Users can only edit their own messages)
      const authUserId = socket.handshake.auth?.userId || user.userId;
      if (message.userId !== authUserId) {
        logger.warn(`Unauthorized message edit attempt: message.userId=${message.userId}, auth.userId=${authUserId}, requester=${user.userId}`);
        socket.emit('error_alert', { message: 'Unauthorized: You can only edit your own messages' });
        return;
      }

      // 3. Action: Update the message content in MongoDB
      message.content = newContent;
      message.editedAt = new Date();
      await message.save();

      const updatedMessage = message.toObject();

      // 4. Normalize message type for frontend consistency
      const normalizedMessage = normalizeMessageType(updatedMessage);

      // 5. Broadcast: Emit message_updated event to the room
      io.to(user.roomCode).emit('messageEdited', normalizedMessage);
      logger.info(`Message ${messageId} edited by user ${authUserId} in room ${user.roomCode}`);
    } catch (error: any) {
      emitErrorAlert(error, 'Error editing message');
    }
  });

  // Alias handlers for snake_case event names (as specified in requirements)
  // These forward to the camelCase handlers above
  socket.on('delete_message', async (data: { messageId: string; roomId?: string }) => {
    // Reuse the deleteMessage handler logic
    const deleteHandler = async (data: { messageId: string; roomId?: string }) => {
      try {
        if (!ensureUserInRoom()) {
          socket.emit('error_alert', { message: 'Not in a room' });
          return;
        }

        if (!data || typeof data !== 'object' || typeof data.messageId !== 'string' || !data.messageId.trim()) {
          socket.emit('error_alert', { message: 'Invalid message ID' });
          return;
        }

        const messageId = data.messageId.trim();
        const roomId = data.roomId?.trim() || user.roomCode;

        const message = await MessageModel.findOne({ id: messageId });
        if (!message) {
          socket.emit('error_alert', { message: 'Message not found' });
          return;
        }

        const room = await getRoomByCode(roomId);
        if (!room) {
          socket.emit('error_alert', { message: 'Room not found' });
          return;
        }

        const authUserId = socket.handshake.auth?.userId || user.userId;
        const canDelete = message.userId === authUserId || (room.ownerId && room.ownerId === authUserId);

        if (!canDelete) {
          logger.warn(`Unauthorized message deletion attempt: message.userId=${message.userId}, auth.userId=${authUserId}, room.ownerId=${room.ownerId}, requester=${user.userId}`);
          socket.emit('error_alert', { message: 'Unauthorized: You can only delete your own messages' });
          return;
        }

        const result = await MessageModel.deleteOne({ id: messageId });
        
        if (result.deletedCount > 0) {
          io.to(roomId).emit('messageDeleted', { messageId });
          logger.info(`Message ${messageId} deleted by user ${authUserId} in room ${roomId}`);
        } else {
          socket.emit('error_alert', { message: 'Failed to delete message' });
        }
      } catch (error: any) {
        emitErrorAlert(error, 'Error deleting message');
      }
    };
    await deleteHandler(data);
  });

  socket.on('edit_message', async (data: { messageId: string; roomId?: string; newContent: string }) => {
    // Reuse the editMessage handler logic
    const editHandler = async (data: { messageId: string; roomId?: string; newContent: string }) => {
      try {
        if (!ensureUserInRoom()) {
          socket.emit('error_alert', { message: 'Not in a room' });
          return;
        }
        
        if (!data || typeof data !== 'object' || typeof data.messageId !== 'string' || typeof data.newContent !== 'string') {
          socket.emit('error_alert', { message: 'Invalid edit data' });
          return;
        }
        
        const messageId = data.messageId.trim();
        const newContent = sanitizeText(data.newContent);
        
        if (!newContent || newContent.trim() === '') {
          socket.emit('error_alert', { message: 'Message cannot be empty' });
          return;
        }

        const message = await MessageModel.findOne({ id: messageId });
        if (!message) {
          socket.emit('error_alert', { message: 'Message not found' });
          return;
        }

        const authUserId = socket.handshake.auth?.userId || user.userId;
        if (message.userId !== authUserId) {
          logger.warn(`Unauthorized message edit attempt: message.userId=${message.userId}, auth.userId=${authUserId}, requester=${user.userId}`);
          socket.emit('error_alert', { message: 'Unauthorized: You can only edit your own messages' });
          return;
        }

        message.content = newContent;
        message.editedAt = new Date();
        await message.save();

        const updatedMessage = message.toObject();
        io.to(user.roomCode).emit('messageEdited', updatedMessage);
        logger.info(`Message ${messageId} edited by user ${authUserId} in room ${user.roomCode}`);
      } catch (error: any) {
        emitErrorAlert(error, 'Error editing message');
      }
    };
    await editHandler(data);
  });

  socket.on('pinMessage', async (data: { messageId: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    if (!data || typeof data.messageId !== 'string') {
      socket.emit('error', { message: 'Invalid message ID' });
      return;
    }
    try {
      const message = await pinMessage(data.messageId.trim(), user.roomCode);
      if (message) {
        // Normalize message type for frontend consistency
        const normalizedMessage = normalizeMessageType(message);
        io.to(user.roomCode).emit('messagePinned', normalizedMessage);
      } else {
        socket.emit('error', { message: 'Message not found' });
      }
    } catch (error: any) {
      logger.error('Error pinning message:', error);
      socket.emit('error', { message: 'Failed to pin message' });
    }
  });

  socket.on('unpinMessage', async (data: { messageId: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    if (!data || typeof data.messageId !== 'string') {
      socket.emit('error', { message: 'Invalid message ID' });
      return;
    }
    try {
      const message = await unpinMessage(data.messageId.trim(), user.roomCode);
      if (message) {
        // Normalize message type for frontend consistency
        const normalizedMessage = normalizeMessageType(message);
        io.to(user.roomCode).emit('messageUnpinned', normalizedMessage);
      } else {
        socket.emit('error', { message: 'Message not found' });
      }
    } catch (error: any) {
      logger.error('Error unpinning message:', error);
      socket.emit('error', { message: 'Failed to unpin message' });
    }
  });

  socket.on('searchMessages', async (data: { query: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    if (!data || typeof data.query !== 'string' || !data.query.trim()) {
      socket.emit('error', { message: 'Invalid search query' });
      return;
    }
    try {
      const messages = await searchMessages(user.roomCode, data.query.trim());
      // Normalize message types for frontend consistency
      const normalizedMessages = normalizeMessages(messages);
      socket.emit('searchResults', { query: data.query.trim(), messages: normalizedMessages });
    } catch (error: any) {
      logger.error('Error searching messages:', error);
      socket.emit('error', { message: 'Failed to search messages' });
    }
  });

  socket.on('getPinnedMessages', async () => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    try {
      const messages = await getPinnedMessages(user.roomCode);
      // Normalize message types for frontend consistency
      const normalizedMessages = normalizeMessages(messages);
      socket.emit('pinnedMessages', normalizedMessages);
    } catch (error: any) {
      logger.error('Error getting pinned messages:', error);
      socket.emit('error', { message: 'Failed to get pinned messages' });
    }
  });

  socket.on('disconnect', async () => {
    // Handle tab close / browser close the same as manual leave_room
    if (user.roomCode) {
      logger.debug(`User ${user.userId} disconnecting from room ${user.roomCode}`);
      
      try {
        // Use the same leave room logic, but don't emit roomLeft (socket is disconnecting)
        await handleUserLeaveRoom(user.roomCode, user.userId, false);
        user.roomCode = ''; // Clear user's room code
      } catch (error: any) {
        logger.error('Error handling disconnect cleanup', {
          error: error instanceof Error ? error.message : String(error),
          roomCode: user.roomCode,
          userId: user.userId,
        });
      }
    }
  });

  socket.on('endRoom', async (data: { userId: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    try {
      const { endRoom } = await import('../services/roomService.js');
      await endRoom(user.roomCode, data.userId);
      io.to(user.roomCode).emit('roomEnded', { endedBy: data.userId });
      logger.info(`Room ${user.roomCode} ended by ${data.userId}`);
    } catch (error: any) {
      logger.error('Error ending room', {
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', { message: 'Failed to end room' });
    }
  });

  socket.on('userLeaveRoom', async (data: { userId: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    try {
      const { removeParticipant } = await import('../services/roomService.js');
      await removeParticipant(user.roomCode, data.userId);
      socket.to(user.roomCode).emit('userLeftRoom', { userId: data.userId });
      socket.leave(user.roomCode);
      logger.info(`User ${data.userId} left room ${user.roomCode}`);
      
      // Emit admin insight update for user leave
      emitAdminInsightUpdate(io, 'user_left', { roomCode: user.roomCode, userId: data.userId }).catch(err => {
        logger.warn('Failed to emit admin insight update for user leave', { error: err instanceof Error ? err.message : String(err) });
      });
    } catch (error: any) {
      logger.error('Error user leaving room', {
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  // Admin End Room Handler - Strict RBAC with ownerId validation
  socket.on('admin_end_room', async (data: { roomId?: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    const targetRoomId = (data.roomId?.trim() || user.roomCode);

    // Verify user is in the target room
    if (user.roomCode !== targetRoomId) {
      socket.emit('error', { message: 'Not in the specified room' });
      return;
    }

    try {
      // 1. Fetch the Room document from DB
      const room = await getRoomByCode(targetRoomId);
      
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      // 2. Security Check: Strictly compare room.ownerId === socket.handshake.auth.userId
      const authUserId = socket.handshake.auth?.userId;
      
      // STRICT CHECK: Only proceed if ownerId matches auth userId
      if (!room.ownerId || !authUserId || room.ownerId !== authUserId) {
        logger.warn(`Unauthorized room termination attempt: room.ownerId=${room.ownerId}, auth.userId=${authUserId}, requester=${user.userId} in room ${targetRoomId}`);
        socket.emit('error_unauthorized', { message: 'Unauthorized: Only the room creator can end the room' });
        return;
      }

      // 3. Success Path: Broadcast system message, then delete everything
      logger.info(`Admin ${user.userId} (ownerId: ${room.ownerId}) ending room ${targetRoomId}`);

      // Check database connection
      if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected', { readyState: mongoose.connection.readyState });
        throw new Error('Database connection not available');
      }

      // Step 1: Broadcast system message "The owner has vanished the room."
      try {
        const systemMessage = await createMessage(
          targetRoomId,
          'system',
          'System',
          'The owner has vanished the room.',
          'text'
        );
        io.to(targetRoomId).emit('newMessage', systemMessage);
        logger.info(`Broadcast system message for room ${targetRoomId}`);
      } catch (msgError: any) {
        logger.warn('Failed to broadcast system message (non-critical)', {
          error: msgError instanceof Error ? msgError.message : String(msgError),
        });
        // Continue with room deletion even if system message fails
      }

      // Step 2: Delete files from storage (GCS or local)
      try {
        await deleteRoomFiles(targetRoomId);
        logger.info(`Deleted files for room ${targetRoomId}`);
      } catch (fileError: any) {
        logger.warn('Failed to delete room files (non-critical)', {
          error: fileError instanceof Error ? fileError.message : String(fileError),
        });
        // Continue with room deletion even if file deletion fails
      }

      // Step 3: Delete all messages
      const messageDeleteResult = await MessageModel.deleteMany({ roomCode: targetRoomId });
      logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${targetRoomId}`);

      // Step 4: Delete the room
      const roomDeleteResult = await RoomModel.deleteOne({ code: targetRoomId });
      logger.info(`Deleted room ${targetRoomId}`, { deleted: roomDeleteResult.deletedCount });

      // Step 5: Emit room_vanished event to all clients (Case 1: Immediate Vanish)
      io.to(targetRoomId).emit('room_vanished', {
        reason: 'The owner has vanished the room.',
        roomId: targetRoomId,
        vanishedBy: user.userId,
      });

      // 5. Force disconnect all sockets in that room
      const socketsInRoom = await io.in(targetRoomId).fetchSockets();
      for (const socketInRoom of socketsInRoom) {
        socketInRoom.leave(targetRoomId);
      }
      // Also use disconnectSockets for complete cleanup
      io.in(targetRoomId).disconnectSockets(true);

      // Redis cleanup (non-critical)
      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.del(`room:${targetRoomId}:users`);
          const socketsInRoomForRedis = await io.in(targetRoomId).fetchSockets();
          for (const socketInRoom of socketsInRoomForRedis) {
            const socketUser = (socketInRoom as any).data?.user;
            if (socketUser?.userId) {
              await redis.del(`user:${socketUser.userId}`);
            }
          }
          logger.info(`Cleaned up Redis data for room ${targetRoomId}`);
        } catch (redisError: any) {
          logger.warn('Redis cleanup failed (non-critical)', {
            error: redisError instanceof Error ? redisError.message : String(redisError),
          });
        }
      }

      logger.info(`Room ${targetRoomId} terminated successfully by admin ${user.userId}. Disconnected ${socketsInRoom.length} sockets.`);
      
      // Emit admin insight update for room vanished
      emitAdminInsightUpdate(io, 'room_vanished', { roomCode: targetRoomId }).catch(err => {
        logger.warn('Failed to emit admin insight update for room vanished', { error: err instanceof Error ? err.message : String(err) });
      });
      
      // Clear user's room code
      user.roomCode = '';
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error ending room', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: targetRoomId,
        userId: user.userId,
      });
      
      // Send error message to client
      let userFriendlyMessage = 'Failed to end room';
      if (errorMessage.includes('not connected') || errorMessage.includes('database')) {
        userFriendlyMessage = 'Database connection error. Please try again.';
      } else if (errorMessage.includes('permission') || errorMessage.includes('unauthorized')) {
        userFriendlyMessage = 'You are not authorized to end this meeting.';
      } else if (errorMessage) {
        userFriendlyMessage = `Failed to end room: ${errorMessage}`;
      }
      
      socket.emit('error', { message: userFriendlyMessage });
    }
  });

  socket.on('destroy_room', async (data: { roomToken?: string; adminSecret?: string; roomId?: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    const targetRoomId = (data.roomId?.trim() || user.roomCode);

    // Verify user is in the target room
    if (user.roomCode !== targetRoomId) {
      socket.emit('error', { message: 'Not in the specified room' });
      return;
    }

    try {
      // 1. Fetch & Verify: Retrieve the Room document from MongoDB
      const room = await getRoomByCode(targetRoomId);
      
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      // 2. The Guard Clause: Strict RBAC - Compare room.ownerId with socket.handshake.auth.userId
      const authUserId = socket.handshake.auth?.userId;
      
      // STRICT CHECK: Only proceed if ownerId matches auth userId
      if (!room.ownerId || !authUserId || room.ownerId !== authUserId) {
        logger.warn(`Unauthorized room destruction attempt: room.ownerId=${room.ownerId}, auth.userId=${authUserId}, requester=${user.userId} in room ${targetRoomId}`);
        socket.emit('error_unauthorized', { message: 'Unauthorized: Only the room creator can end the room' });
        return;
      }

      // IF MATCH: Proceed to delete

      logger.info(`Admin ${user.userId} destroying room ${targetRoomId}`);

      // 3. Check database connection
      if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected', { readyState: mongoose.connection.readyState });
        throw new Error('Database connection not available');
      }

      // 4. Cleanup Sequence (as specified by requirements)
      // Step 1: Delete all messages
      const messageDeleteResult = await MessageModel.deleteMany({ roomCode: targetRoomId });
      logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${targetRoomId}`);

      // Step 2: Delete the room
      const roomDeleteResult = await RoomModel.deleteOne({ code: targetRoomId });
      logger.info(`Deleted room ${targetRoomId}`, { deleted: roomDeleteResult.deletedCount });

      // Step 3: Emit room_destroyed event to all participants
      io.to(targetRoomId).emit('room_destroyed', {
        reason: 'Host ended the meeting',
        roomId: targetRoomId,
        destroyedBy: user.userId,
      });

      // Step 4: Force disconnect all sockets in the room
      io.in(targetRoomId).disconnectSockets(true);

      // 5. Redis Cleanup (non-critical, continue even if it fails)
      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.del(`room:${targetRoomId}:users`);
          logger.info(`Cleaned up Redis data for room ${targetRoomId}`);
        } catch (redisError: any) {
          logger.warn('Redis cleanup failed (non-critical)', {
            error: redisError instanceof Error ? redisError.message : String(redisError),
          });
        }
      }

      logger.info(`Room ${targetRoomId} destroyed successfully by admin ${user.userId}`);
      
      // Clear user's room code
      user.roomCode = '';
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error destroying room', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: targetRoomId,
        userId: user.userId,
      });
      
      // Send more descriptive error message to client
      let userFriendlyMessage = 'Failed to destroy room';
      if (errorMessage.includes('not connected') || errorMessage.includes('database')) {
        userFriendlyMessage = 'Database connection error. Please try again.';
      } else if (errorMessage.includes('transaction')) {
        userFriendlyMessage = 'Database transaction failed. Please try again.';
      } else if (errorMessage.includes('permission') || errorMessage.includes('unauthorized')) {
        userFriendlyMessage = 'You are not authorized to end this meeting.';
      } else if (errorMessage) {
        userFriendlyMessage = `Failed to destroy room: ${errorMessage}`;
      }
      
      socket.emit('error', { message: userFriendlyMessage });
    }
  });

  // Legacy handler for backward compatibility
  socket.on('admin_close_room', async (data: { roomToken: string }) => {
    // Forward to destroy_room handler by calling it with the same data structure
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    // Call destroy_room handler logic
    const destroyData = { roomToken: data.roomToken, roomId: user.roomCode };
    
    // Manually trigger the destroy_room logic
    // We'll reuse the same validation and cleanup code
    if (!data || typeof data.roomToken !== 'string' || !data.roomToken.trim()) {
      socket.emit('error', { message: 'Invalid room token' });
      return;
    }

    const targetRoomId = user.roomCode;

    try {
      const room = await getRoomByCode(targetRoomId);
      
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const isAdmin = verifyRoomToken(data.roomToken, targetRoomId);
      if (!isAdmin) {
        logger.warn(`Unauthorized room closure attempt by user ${user.userId} in room ${targetRoomId}`);
        socket.emit('error', { message: 'Unauthorized: Only the room creator can close the room' });
        return;
      }

      logger.info(`Admin ${user.userId} closing room ${targetRoomId} (legacy handler)`);

      // Check database connection
      if (mongoose.connection.readyState !== 1) {
        logger.error('Database not connected', { readyState: mongoose.connection.readyState });
        throw new Error('Database connection not available');
      }

      let cleanupResult;
      let useTransaction = false;
      
      // Try transaction first (only works with replica sets)
      try {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const messageDeleteResult = await MessageModel.deleteMany(
              { roomCode: targetRoomId },
              { session }
            );
            logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${targetRoomId}`);

            const roomDeleteResult = await RoomModel.deleteOne(
              { code: targetRoomId },
              { session }
            );
            logger.info(`Deleted room ${targetRoomId}`, { deleted: roomDeleteResult.deletedCount });

            cleanupResult = {
              messagesDeleted: messageDeleteResult.deletedCount,
              roomDeleted: roomDeleteResult.deletedCount,
            };
          });
          useTransaction = true;
        } catch (transactionError: any) {
          logger.warn('Transaction failed, will use direct deletes', {
            error: transactionError instanceof Error ? transactionError.message : String(transactionError),
          });
          // Don't throw, will use fallback below
        } finally {
          await session.endSession();
        }
      } catch (sessionError: any) {
        logger.info('Cannot start session (likely not a replica set), using direct deletes', {
          error: sessionError instanceof Error ? sessionError.message : String(sessionError),
        });
        // Will use fallback below
      }
      
      // Fallback: Direct deletes if transaction not available or failed
      if (!useTransaction) {
        logger.info('Using direct deletes (no transaction)');
        const messageDeleteResult = await MessageModel.deleteMany({ roomCode: targetRoomId });
        logger.info(`Deleted ${messageDeleteResult.deletedCount} messages from room ${targetRoomId}`);

        const roomDeleteResult = await RoomModel.deleteOne({ code: targetRoomId });
        logger.info(`Deleted room ${targetRoomId}`, { deleted: roomDeleteResult.deletedCount });

        cleanupResult = {
          messagesDeleted: messageDeleteResult.deletedCount,
          roomDeleted: roomDeleteResult.deletedCount,
        };
      }

      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.del(`room:${targetRoomId}:users`);
          
          const socketsInRoom = await io.in(targetRoomId).fetchSockets();
          for (const socketInRoom of socketsInRoom) {
            const socketUser = (socketInRoom as any).data?.user;
            if (socketUser?.userId) {
              await redis.del(`user:${socketUser.userId}`);
            }
          }
          
          logger.info(`Cleaned up Redis data for room ${targetRoomId}`);
        } catch (redisError: any) {
          logger.warn('Redis cleanup failed (non-critical)', {
            error: redisError instanceof Error ? redisError.message : String(redisError),
          });
        }
      }

      io.to(targetRoomId).emit('room_terminated', {
        reason: 'Host ended the session',
        roomId: targetRoomId,
        terminatedBy: user.userId,
      });

      const socketsInRoom = await io.in(targetRoomId).fetchSockets();
      for (const socketInRoom of socketsInRoom) {
        socketInRoom.leave(targetRoomId);
      }

      logger.info(`Room ${targetRoomId} closed successfully by admin ${user.userId}. Disconnected ${socketsInRoom.length} sockets.`, cleanupResult);
      
      user.roomCode = '';
    } catch (error: any) {
      logger.error('Error closing room (legacy handler)', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        roomCode: targetRoomId,
        userId: user.userId,
      });
      socket.emit('error', { message: 'Failed to close room' });
    }
  });
};

