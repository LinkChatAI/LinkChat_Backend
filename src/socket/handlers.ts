import { Server, Socket } from 'socket.io';
import { SocketUser } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

import { HandlerContext } from './handlers/types.js';
import { registerJoinHandlers } from './handlers/joinHandlers.js';
import { registerMessageHandlers } from './handlers/messageHandlers.js';
import { registerReactionHandlers } from './handlers/reactionHandlers.js';
import { registerRoomLifecycleHandlers } from './handlers/roomLifecycleHandlers.js';
import { registerScreenShareHandlers } from './handlers/screenShareHandlers.js';
import { registerModerationHandlers } from './handlers/moderationHandlers.js';
import { registerRoomAdminHandlers } from './handlers/roomAdminHandlers.js';
import { recordReconnect } from '../services/platformMetricsService.js';

// Re-export for backward compatibility (adminRoomService imports this)
export { clearPendingDeletionTimer } from './handlers/roomLifecycleHandlers.js';

export const handleSocketConnection = (io: Server, socket: Socket): void => {
  if ((socket as any).recovered) {
    recordReconnect();
  }

  const authUserId = socket.handshake.auth?.userId;
  const user: SocketUser = {
    userId: (authUserId && typeof authUserId === 'string' && authUserId.trim()) ? authUserId.trim() : uuidv4(),
    nickname: socket.handshake.auth?.nickname || 'Anonymous',
    roomCode: '',
  };

  const typingUsers = new Map<string, NodeJS.Timeout>();

  const ensureUserInRoom = (): boolean => {
    if (!user.roomCode || user.roomCode.trim() === '') return false;
    const room = io.sockets.adapter.rooms.get(user.roomCode);
    return room ? room.has(socket.id) : false;
  };

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

  const ctx: HandlerContext = {
    io,
    socket,
    user,
    typingUsers,
    ensureUserInRoom,
    emitErrorAlert,
  };

  registerJoinHandlers(ctx);
  registerMessageHandlers(ctx);
  registerReactionHandlers(ctx);
  registerRoomLifecycleHandlers(ctx);
  registerScreenShareHandlers(ctx);
  registerModerationHandlers(ctx);
  registerRoomAdminHandlers(ctx);
};
