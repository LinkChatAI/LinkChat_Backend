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
import { trackSocketConnected, trackSocketDisconnected } from '../services/metricsService.js';
import { clearPendingUserLeaveTimer } from './handlers/roomLifecycleHandlers.js';

// Re-export for backward compatibility (adminRoomService imports this)
export { clearPendingDeletionTimer } from './handlers/roomLifecycleHandlers.js';

export const handleSocketConnection = (io: Server, socket: Socket): void => {
  const recovered = (socket as any).recovered === true;
  if (recovered) {
    recordReconnect();
  }

  trackSocketConnected();
  socket.on('disconnect', () => trackSocketDisconnected());

  // On a successful connectionStateRecovery, Socket.IO already restores
  // socket.data (including the `user` object we stash there in joinHandlers)
  // before the 'connection' event fires. Reuse it instead of building a blank
  // user with roomCode: '' — otherwise ensureUserInRoom() (which gates
  // sendMessage/typing/edits/reactions) would wrongly fail right after a
  // "successful" silent recovery, since the client intentionally skips
  // re-emitting joinRoom in that case.
  const recoveredUser = recovered ? ((socket as any).data?.user as SocketUser | undefined) : undefined;

  const authUserId = socket.handshake.auth?.userId;
  const user: SocketUser = recoveredUser ?? {
    userId: (authUserId && typeof authUserId === 'string' && authUserId.trim()) ? authUserId.trim() : uuidv4(),
    nickname: socket.handshake.auth?.nickname || 'Anonymous',
    roomCode: '',
  };
  (socket as any).data = { user };

  // Recovery means this connection never went through joinRoom again — clear
  // any grace-period removal timer started by the disconnect that preceded
  // this recovery, since the user is provably still here.
  if (recovered && user.roomCode) {
    clearPendingUserLeaveTimer(user.roomCode, user.userId);
  }

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
