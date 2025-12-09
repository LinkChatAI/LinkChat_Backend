import { Server, Socket } from 'socket.io';
import { getRedisClient, isRedisAvailable } from '../config/redis';
import { getRoomByCode } from '../services/roomService';
import { createMessage, getRoomMessages, deleteMessage, addReaction, removeReaction } from '../services/messageService';
import { getFileUrl } from '../services/gcsService';
import { SocketUser } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { validateMessageSize, validateFileSize } from '../utils/validation';
import { logger } from '../utils/logger';
import { socketRateLimiter } from '../middleware/rateLimiter';
import { sanitizeName, sanitizeText } from '../utils/sanitize';

const getRedis = () => getRedisClient();

export const handleSocketConnection = (io: Server, socket: Socket): void => {
  const user: SocketUser = {
    userId: uuidv4(),
    nickname: 'Anonymous',
    roomCode: '',
  };

  socket.on('joinRoom', async (data: { code: string; nickname?: string }) => {
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

      // Sanitize nickname
      const nickname = data.nickname ? sanitizeName(data.nickname) : 'Anonymous';

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

      // Leave previous room if in one
      if (user.roomCode && user.roomCode !== code) {
        socket.leave(user.roomCode);
      }

      user.roomCode = code;
      user.nickname = nickname;
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
        } catch (error) {
          // Ignore Redis errors, continue without it
        }
      }

      const messages = await getRoomMessages(code);
      socket.emit('roomJoined', { messages, userId: user.userId });
      socket.to(code).emit('userJoined', { userId: user.userId, nickname: user.nickname });

      // Get user count from Redis or use socket.io room size
      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${code}:users`);
        } catch (error) {
          // Fallback to socket.io room size
          userCount = io.sockets.adapter.rooms.get(code)?.size || 0;
        }
      } else {
        userCount = io.sockets.adapter.rooms.get(code)?.size || 0;
      }
      io.to(code).emit('userCount', { count: userCount });
      logger.info(`User ${user.userId} joined room ${code}`);
    } catch (error) {
      logger.error('Error joining room:', error);
      socket.emit('error', { 
        message: error instanceof Error ? error.message : 'Failed to join room' 
      });
    }
  });

  socket.on('sendMessage', async (data: { content: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    // Validate input
    if (!data || typeof data.content !== 'string') {
      socket.emit('error', { message: 'Invalid message content' });
      return;
    }

    const content = sanitizeText(data.content);
    if (!content) {
      socket.emit('error', { message: 'Message cannot be empty' });
      return;
    }

    // Rate limit: 30 messages per minute
    const allowed = await socketRateLimiter(socket.id, 'sendMessage', 30, 60000);
    if (!allowed) {
      socket.emit('error', { message: 'Too many messages. Please slow down.' });
      return;
    }

    const validation = validateMessageSize(content);
    if (!validation.valid) {
      logger.warn(`Message size validation failed for user ${user.userId}: ${validation.error}`);
      socket.emit('error', { message: validation.error || 'Message validation failed' });
      return;
    }

    try {
      const message = await createMessage(
        user.roomCode,
        user.userId,
        user.nickname,
        content,
        'text'
      );
      io.to(user.roomCode).emit('newMessage', message);
      logger.debug(`Message sent in room ${user.roomCode} by user ${user.userId}`);
    } catch (error) {
      logger.error('Error sending message:', error);
      socket.emit('error', { 
        message: error instanceof Error ? error.message : 'Failed to send message' 
      });
    }
  });

  socket.on('sendFileMeta', async (data: { filePath: string; fileName: string; fileSize: number; mimeType: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    // Validate input
    if (!data || 
        typeof data.filePath !== 'string' || 
        typeof data.fileName !== 'string' || 
        typeof data.fileSize !== 'number' || 
        typeof data.mimeType !== 'string') {
      socket.emit('error', { message: 'Invalid file metadata' });
      return;
    }

    // Rate limit: 10 files per minute
    const allowed = await socketRateLimiter(socket.id, 'sendFileMeta', 10, 60000);
    if (!allowed) {
      socket.emit('error', { message: 'Too many file uploads. Please slow down.' });
      return;
    }

    const validation = validateFileSize(data.fileSize);
    if (!validation.valid) {
      logger.warn(`File size validation failed for user ${user.userId}: ${validation.error}`);
      socket.emit('error', { message: validation.error || 'File validation failed' });
      return;
    }

    try {
      let fileUrl: string;
      try {
        fileUrl = getFileUrl(data.filePath);
      } catch (gcsError) {
        logger.error('Error getting file URL:', gcsError);
        socket.emit('error', { message: 'File storage is not configured. Cannot share file.' });
        return;
      }

      const message = await createMessage(
        user.roomCode,
        user.userId,
        user.nickname,
        `Shared file: ${data.fileName}`,
        'file',
        {
          name: data.fileName,
          size: data.fileSize,
          url: fileUrl,
          mimeType: data.mimeType,
        }
      );
      io.to(user.roomCode).emit('newMessage', message);
      logger.debug(`File shared in room ${user.roomCode} by user ${user.userId}: ${data.fileName}`);
    } catch (error) {
      logger.error('Error sharing file:', error);
      socket.emit('error', { message: error instanceof Error ? error.message : 'Failed to share file' });
    }
  });

  socket.on('leaveRoom', async () => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    try {
      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.srem(`room:${user.roomCode}:users`, user.userId);
          await redis.del(`user:${user.userId}`);
        } catch (error) {
          // Ignore Redis errors
        }
      }
      
      socket.leave(user.roomCode);
      socket.to(user.roomCode).emit('userLeft', { userId: user.userId });

      // Get user count from Redis or use socket.io room size
      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${user.roomCode}:users`);
        } catch (error) {
          userCount = io.sockets.adapter.rooms.get(user.roomCode)?.size || 0;
        }
      } else {
        userCount = io.sockets.adapter.rooms.get(user.roomCode)?.size || 0;
      }
      io.to(user.roomCode).emit('userCount', { count: userCount });

      user.roomCode = '';
      socket.emit('roomLeft');
    } catch (error) {
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });

  socket.on('deleteMessage', async (data: { messageId: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    // Validate input
    if (!data || typeof data.messageId !== 'string' || !data.messageId.trim()) {
      socket.emit('error', { message: 'Invalid message ID' });
      return;
    }

    try {
      const deleted = await deleteMessage(data.messageId.trim(), user.userId);
      if (deleted) {
        io.to(user.roomCode).emit('messageDeleted', { messageId: data.messageId.trim() });
      } else {
        socket.emit('error', { message: 'Message not found or unauthorized' });
      }
    } catch (error) {
      logger.error('Error deleting message:', error);
      socket.emit('error', { 
        message: error instanceof Error ? error.message : 'Failed to delete message' 
      });
    }
  });

  socket.on('addReaction', async (data: { messageId: string; emoji: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    // Validate input
    if (!data || 
        typeof data.messageId !== 'string' || 
        !data.messageId.trim() ||
        typeof data.emoji !== 'string' || 
        !data.emoji.trim()) {
      socket.emit('error', { message: 'Invalid reaction data' });
      return;
    }

    // Validate emoji (basic check - should be a single emoji or short string)
    const emoji = data.emoji.trim();
    if (emoji.length > 10) {
      socket.emit('error', { message: 'Invalid emoji' });
      return;
    }

    try {
      const message = await addReaction(data.messageId.trim(), user.userId, emoji);
      if (message) {
        io.to(user.roomCode).emit('reactionAdded', {
          messageId: data.messageId.trim(),
          emoji,
          userId: user.userId,
        });
      } else {
        socket.emit('error', { message: 'Message not found' });
      }
    } catch (error) {
      logger.error('Error adding reaction:', error);
      socket.emit('error', { 
        message: error instanceof Error ? error.message : 'Failed to add reaction' 
      });
    }
  });

  socket.on('removeReaction', async (data: { messageId: string; emoji: string }) => {
    if (!user.roomCode) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }

    // Validate input
    if (!data || 
        typeof data.messageId !== 'string' || 
        !data.messageId.trim() ||
        typeof data.emoji !== 'string' || 
        !data.emoji.trim()) {
      socket.emit('error', { message: 'Invalid reaction data' });
      return;
    }

    const emoji = data.emoji.trim();
    if (emoji.length > 10) {
      socket.emit('error', { message: 'Invalid emoji' });
      return;
    }

    try {
      const message = await removeReaction(data.messageId.trim(), user.userId, emoji);
      if (message) {
        io.to(user.roomCode).emit('reactionRemoved', {
          messageId: data.messageId.trim(),
          emoji,
          userId: user.userId,
        });
      } else {
        socket.emit('error', { message: 'Message not found' });
      }
    } catch (error) {
      logger.error('Error removing reaction:', error);
      socket.emit('error', { 
        message: error instanceof Error ? error.message : 'Failed to remove reaction' 
      });
    }
  });

  socket.on('disconnect', async () => {
    if (user.roomCode) {
      logger.debug(`User ${user.userId} disconnecting from room ${user.roomCode}`);
      
      const redis = getRedis();
      if (redis && isRedisAvailable()) {
        try {
          await redis.srem(`room:${user.roomCode}:users`, user.userId);
          await redis.del(`user:${user.userId}`);
        } catch (error) {
          // Ignore Redis errors
        }
      }

      socket.to(user.roomCode).emit('userLeft', { userId: user.userId });

      // Get user count from Redis or use socket.io room size
      let userCount = 0;
      if (redis && isRedisAvailable()) {
        try {
          userCount = await redis.scard(`room:${user.roomCode}:users`);
        } catch (error) {
          userCount = io.sockets.adapter.rooms.get(user.roomCode)?.size || 0;
        }
      } else {
        userCount = io.sockets.adapter.rooms.get(user.roomCode)?.size || 0;
      }
      io.to(user.roomCode).emit('userCount', { count: userCount });
      logger.info(`User ${user.userId} left room ${user.roomCode}`);
    }
  });
};

