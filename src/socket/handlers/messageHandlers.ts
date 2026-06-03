import xss from 'xss';
import { getRedisClient, isRedisAvailable } from '../../config/redis.js';
import { getRoomByCode } from '../../services/roomService.js';
import {
  createMessage,
  getRoomMessages,
  getMessagesAfterId,
  addReaction,
  removeReaction,
  editMessage,
  pinMessage,
  unpinMessage,
  searchMessages,
  getPinnedMessages,
} from '../../services/messageService.js';
import { Message } from '../../types/index.js';
import { validateMessageSize } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';
import { socketRateLimiter } from '../../middleware/rateLimiter.js';
import { MessageModel } from '../../models/Message.js';
import { emitAdminInsightUpdate } from '../adminHandlers.js';
import { HandlerContext, normalizeMessageType, normalizeMessages } from './types.js';
import { isUserMuted } from '../../services/roomModerationService.js';
import { canModerateRoom } from '../../services/roomPermissionService.js';
import { checkSlowMode } from '../../services/slowModeService.js';

export const registerMessageHandlers = (ctx: HandlerContext): void => {
  const { io, socket, user, ensureUserInRoom, emitErrorAlert, typingUsers } = ctx;

  socket.on('sync_messages', async (
    data: { lastMessageId?: string },
    ack?: (response: { success: boolean; messages?: Message[]; error?: string }) => void,
  ) => {
    try {
      if (!ensureUserInRoom()) {
        const errorMsg = 'Not in a room';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      if (data && data.lastMessageId && typeof data.lastMessageId !== 'string') {
        const errorMsg = 'Invalid lastMessageId format';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const messages = await getMessagesAfterId(user.roomCode, data?.lastMessageId);
      const normalizedMessages = normalizeMessages(messages);
      socket.emit('messages_synced', { messages: normalizedMessages });

      if (ack) ack({ success: true, messages: normalizedMessages });
      logger.debug(`Synced ${messages.length} messages for user ${user.userId} in room ${user.roomCode}`);
    } catch (error: any) {
      emitErrorAlert(error, 'Failed to sync messages');
      if (ack) ack({ success: false, error: error instanceof Error ? error.message : 'Failed to sync messages' });
    }
  });

  socket.on('sendMessage', async (
    data: {
      content: string;
      type?: 'text' | 'file' | 'image' | 'video';
      fileKey?: string;
      fileMeta?: any;
      replyTo?: string;
      tempId?: string;
    },
    ack?: (response: { success: boolean; messageId?: string; error?: string }) => void,
  ) => {
    try {
      if (!ensureUserInRoom()) {
        const errorMsg = 'Not in a room. Please join a room first.';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const room = await getRoomByCode(user.roomCode);
      if (room?.isLocked) {
        const errorMsg = 'Room is locked. No new messages can be sent.';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const authUserId = socket.handshake.auth?.userId || user.userId;
      if (isUserMuted(user.roomCode, authUserId)) {
        const errorMsg = 'You are muted in this room.';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const slowLimit = room?.slowModeMessagesPerMinute ?? 0;
      if (
        slowLimit > 0 &&
        !canModerateRoom(room, authUserId) &&
        !checkSlowMode(user.roomCode, authUserId, slowLimit)
      ) {
        const errorMsg = `Slow mode: max ${slowLimit} message${slowLimit === 1 ? '' : 's'} per minute.`;
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      if (!data || typeof data !== 'object') {
        const errorMsg = 'Invalid message data';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      if (typeof data.content !== 'string') {
        const errorMsg = 'Message content must be a string';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      if (!data.type || data.type === 'text') {
        if (data.content.trim() === '') {
          const errorMsg = 'Message content cannot be empty';
          socket.emit('error_alert', { message: errorMsg });
          if (ack) ack({ success: false, error: errorMsg });
          return;
        }
      }

      if (typeof user.roomCode !== 'string' || !user.roomCode.trim()) {
        const errorMsg = 'Invalid room code';
        socket.emit('error_alert', { message: errorMsg });
        if (ack) ack({ success: false, error: errorMsg });
        return;
      }

      const isDataUrlMessage = data.content.includes('[File:') && data.content.includes('](data:');

      let content: string;
      if (isDataUrlMessage) {
        content = data.content.trim();
      } else if (data.type === 'file' || data.type === 'image' || data.type === 'video') {
        if (data.content.trim()) {
          content = xss(data.content.trim());
        } else {
          content = data.fileMeta?.name ? `Shared file: ${data.fileMeta.name}` : 'Shared file';
        }
      } else {
        const trimmedContent = data.content.trim();
        content = xss(trimmedContent);
        if (!content || content.trim() === '') {
          const errorMsg = 'Message cannot be empty after sanitization';
          socket.emit('error_alert', { message: errorMsg });
          if (ack) ack({ success: false, error: errorMsg });
          return;
        }
      }

      logger.debug('Processing message', {
        isDataUrl: isDataUrlMessage,
        contentLength: content.length,
        userId: user.userId,
        roomCode: user.roomCode,
      });

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

      if ((data.type === 'file' || data.type === 'image' || data.type === 'video') && data.fileKey && data.fileMeta) {
        if (
          !data.fileMeta || typeof data.fileMeta !== 'object' ||
          typeof data.fileMeta.name !== 'string' ||
          typeof data.fileMeta.size !== 'number' ||
          typeof data.fileMeta.mimeType !== 'string'
        ) {
          const errorMsg = 'Invalid file metadata';
          socket.emit('error_alert', { message: errorMsg });
          if (ack) ack({ success: false, error: errorMsg });
          return;
        }

        const recentDuplicate = await MessageModel.findOne({
          roomCode: user.roomCode,
          userId: user.userId,
          type: 'file',
          'fileMeta.name': data.fileMeta.name,
          createdAt: { $gte: new Date(Date.now() - 10000) },
        }).lean().exec();

        if (recentDuplicate) {
          logger.debug('Duplicate file message prevented', {
            messageId: recentDuplicate.id,
            fileName: data.fileMeta.name,
            userId: user.userId,
          });
          const existingMessage = normalizeMessageType(recentDuplicate);
          if (data.tempId) (existingMessage as any).tempId = data.tempId;
          io.to(user.roomCode).emit('newMessage', existingMessage);
          if (ack) ack({ success: true, messageId: existingMessage.id });
          return;
        }

        const { getFileUrl, getImageUrl } = await import('../../services/gcsService.js');
        const isImage = data.fileMeta.mimeType && data.fileMeta.mimeType.startsWith('image/');

        let fileUrl: string;
        try {
          fileUrl = isImage
            ? await getImageUrl(data.fileKey)
            : getFileUrl(data.fileKey);
        } catch (gcsError: any) {
          logger.warn('Unexpected error from gcsService — using local fallback URL', {
            error: gcsError instanceof Error ? gcsError.message : String(gcsError),
          });
          const backendUrl = process.env.BACKEND_URL || 'http://localhost:8080';
          fileUrl = `${backendUrl}/uploads/${data.fileKey}`;
        }

        const dbType: 'text' | 'file' = 'file';
        message = await createMessage(
          user.roomCode, user.userId, user.nickname, content, dbType,
          {
            name: data.fileMeta.name,
            size: data.fileMeta.size,
            url: fileUrl,
            mimeType: data.fileMeta.mimeType,
          },
          data.replyTo,
          avatar
        );

        if (data.type === 'image' || (data.fileMeta.mimeType && data.fileMeta.mimeType.startsWith('image/'))) {
          message.type = 'image' as any;
        } else if (data.type === 'video' || (data.fileMeta.mimeType && data.fileMeta.mimeType.startsWith('video/'))) {
          message.type = 'video' as any;
        }

        if (data.tempId) (message as any).tempId = data.tempId;
      } else {
        message = await createMessage(
          user.roomCode, user.userId, user.nickname, content, 'text',
          undefined, data.replyTo, avatar
        );
        if (data.tempId) (message as any).tempId = data.tempId;
      }

      io.to(user.roomCode).emit('newMessage', message);
      logger.debug(`Message sent in room ${user.roomCode} by user ${user.userId}`, {
        messageId: message.id,
        hasFile: data.type === 'file' || data.type === 'image' || content.includes('[File:'),
        contentLength: content.length,
      });

      emitAdminInsightUpdate(
        io,
        data.type === 'file' || data.type === 'image' ? 'file_uploaded' : 'message_sent',
        { roomCode: user.roomCode, messageType: message.type, fileSize: data.fileMeta?.size || 0 }
      ).catch(err => {
        logger.warn('Failed to emit admin insight update for message', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      if (ack) ack({ success: true, messageId: message.id });
    } catch (error: any) {
      emitErrorAlert(error, 'Error sending message');
      if (ack) ack({ success: false, error: error instanceof Error ? error.message : 'Failed to send message' });
    }
  });

  socket.on('deleteMessage', async (data: { messageId: string; roomId?: string }) => {
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
      const isModerator = canModerateRoom(room, authUserId);
      const isOwnMessage = message.userId === authUserId;
      const canDelete = isOwnMessage || isModerator;

      if (!canDelete) {
        logger.warn(`Unauthorized message deletion attempt: message.userId=${message.userId}, auth.userId=${authUserId}, room.ownerId=${room.ownerId}, requester=${user.userId}`);
        socket.emit('error_alert', { message: 'Unauthorized: You can only delete your own messages' });
        return;
      }

      if (isModerator && !isOwnMessage) {
        const result = await MessageModel.updateOne(
          { id: messageId },
          {
            $set: {
              deletedByAdmin: true,
              content: '[Message deleted by admin]',
              type: 'text',
            },
            $unset: { fileMeta: '' },
          }
        );

        if (result.modifiedCount > 0) {
          const updatedMessage = await MessageModel.findOne({ id: messageId }).lean();
          io.to(roomId).emit('messageDeleted', {
            messageId,
            deletedByAdmin: true,
            message: updatedMessage
              ? { ...updatedMessage, deletedByAdmin: true, content: '[Message deleted by admin]' }
              : undefined,
          });
          logger.info(`Message ${messageId} deleted by admin ${authUserId} in room ${roomId}`);

          if (message.type === 'file' && message.fileMeta?.size) {
            emitAdminInsightUpdate(io, 'file_deleted', { roomCode: roomId, fileSize: message.fileMeta.size }).catch(err => {
              logger.warn('Failed to emit admin insight update for file deletion by admin', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } else {
          socket.emit('error_alert', { message: 'Failed to delete message' });
        }
      } else {
        const result = await MessageModel.deleteOne({ id: messageId });

        if (result.deletedCount > 0) {
          io.to(roomId).emit('messageDeleted', { messageId, deletedByAdmin: false });
          logger.info(`Message ${messageId} deleted by user ${authUserId} in room ${roomId}`);

          if (message.type === 'file' && message.fileMeta?.size) {
            emitAdminInsightUpdate(io, 'file_deleted', { roomCode: roomId, fileSize: message.fileMeta.size }).catch(err => {
              logger.warn('Failed to emit admin insight update for file deletion', {
                error: err instanceof Error ? err.message : String(err),
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

  // Alias for snake_case compatibility
  socket.on('delete_message', async (data: { messageId: string; roomId?: string }) => {
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
      const canDelete =
        message.userId === authUserId || canModerateRoom(room, authUserId);

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
  });

  socket.on('editMessage', async (data: { messageId: string; roomId?: string; newContent: string }) => {
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
      const newContent = xss(data.newContent.trim());

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
      const normalizedMessage = normalizeMessageType(updatedMessage);

      io.to(user.roomCode).emit('messageEdited', normalizedMessage);
      logger.info(`Message ${messageId} edited by user ${authUserId} in room ${user.roomCode}`);
    } catch (error: any) {
      emitErrorAlert(error, 'Error editing message');
    }
  });

  // Alias for snake_case compatibility
  socket.on('edit_message', async (data: { messageId: string; roomId?: string; newContent: string }) => {
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
      const newContent = xss(data.newContent.trim());

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
      const normalizedMessages = normalizeMessages(messages);
      socket.emit('pinnedMessages', normalizedMessages);
    } catch (error: any) {
      logger.error('Error getting pinned messages:', error);
      socket.emit('error', { message: 'Failed to get pinned messages' });
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

  socket.on('stopTyping', () => {
    if (!user.roomCode) return;
    const key = `${user.roomCode}:${user.userId}`;
    if (typingUsers.has(key)) {
      clearTimeout(typingUsers.get(key)!);
      typingUsers.delete(key);
    }
    socket.to(user.roomCode).emit('userStoppedTyping', { userId: user.userId });
  });
};
