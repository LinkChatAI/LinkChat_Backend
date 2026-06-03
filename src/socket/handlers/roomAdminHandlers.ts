import {
  getRoomByCode,
  transferRoomOwnership,
  addRoomCoHost,
  removeRoomCoHost,
  setRoomSlowMode,
} from '../../services/roomService.js';
import { canManageRoom, canModerateRoom } from '../../services/roomPermissionService.js';
import { logger } from '../../utils/logger.js';
import { HandlerContext } from './types.js';
import { Room } from '../../types/index.js';

const emitRoomSettings = (io: HandlerContext['io'], roomCode: string, room: Room): void => {
  io.to(roomCode).emit('roomSettingsUpdated', {
    ownerId: room.ownerId,
    coHostIds: room.coHostIds || [],
    slowModeMessagesPerMinute: room.slowModeMessagesPerMinute ?? 0,
  });
};

const userIsInRoom = async (
  io: HandlerContext['io'],
  roomCode: string,
  userId: string,
): Promise<boolean> => {
  const sockets = await io.in(roomCode).fetchSockets();
  return sockets.some((s) => (s as any).data?.user?.userId === userId);
};

export const registerRoomAdminHandlers = (ctx: HandlerContext): void => {
  const { io, socket, user, ensureUserInRoom } = ctx;

  socket.on('transferHost', async (data: { userId: string }) => {
    if (!ensureUserInRoom() || !data?.userId) return;
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canManageRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host can transfer ownership' });
      return;
    }
    if (data.userId === authUserId) {
      socket.emit('error', { message: 'You are already the host' });
      return;
    }
    if (!(await userIsInRoom(io, user.roomCode, data.userId))) {
      socket.emit('error', { message: 'User must be in the room to become host' });
      return;
    }

    try {
      const updated = await transferRoomOwnership(user.roomCode, data.userId);
      emitRoomSettings(io, user.roomCode, updated);
      io.to(user.roomCode).emit('hostTransferred', {
        roomId: user.roomCode,
        newOwnerId: data.userId,
        previousOwnerId: authUserId,
      });
      logger.info('Host transferred', { roomCode: user.roomCode, newOwnerId: data.userId });
    } catch (error) {
      socket.emit('error', { message: 'Failed to transfer host' });
    }
  });

  socket.on('addCoHost', async (data: { userId: string }) => {
    if (!ensureUserInRoom() || !data?.userId) return;
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canManageRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host can add co-hosts' });
      return;
    }
    if (data.userId === room?.ownerId) {
      socket.emit('error', { message: 'Host is already the room owner' });
      return;
    }
    if (!(await userIsInRoom(io, user.roomCode, data.userId))) {
      socket.emit('error', { message: 'User must be in the room' });
      return;
    }

    try {
      const updated = await addRoomCoHost(user.roomCode, data.userId);
      emitRoomSettings(io, user.roomCode, updated);
      io.to(user.roomCode).emit('coHostAdded', { userId: data.userId, roomId: user.roomCode });
    } catch {
      socket.emit('error', { message: 'Failed to add co-host' });
    }
  });

  socket.on('removeCoHost', async (data: { userId: string }) => {
    if (!ensureUserInRoom() || !data?.userId) return;
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canManageRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host can remove co-hosts' });
      return;
    }

    try {
      const updated = await removeRoomCoHost(user.roomCode, data.userId);
      emitRoomSettings(io, user.roomCode, updated);
      io.to(user.roomCode).emit('coHostRemoved', { userId: data.userId, roomId: user.roomCode });
    } catch {
      socket.emit('error', { message: 'Failed to remove co-host' });
    }
  });

  socket.on('updateSlowMode', async (data: { messagesPerMinute: number }) => {
    if (!ensureUserInRoom() || data?.messagesPerMinute === undefined) return;
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canManageRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host can change slow mode' });
      return;
    }

    try {
      const updated = await setRoomSlowMode(user.roomCode, data.messagesPerMinute);
      emitRoomSettings(io, user.roomCode, updated);
      io.to(user.roomCode).emit('slowModeUpdated', {
        roomId: user.roomCode,
        messagesPerMinute: updated.slowModeMessagesPerMinute ?? 0,
      });
    } catch {
      socket.emit('error', { message: 'Failed to update slow mode' });
    }
  });
};

export { canModerateRoom, canManageRoom };
