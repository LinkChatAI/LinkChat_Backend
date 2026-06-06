import { getRoomByCode } from '../../services/roomService.js';
import {
  muteUser,
  unmuteUser,
  kickUser,
  isUserMuted,
  getMutedUserIds,
} from '../../services/roomModerationService.js';
import { canModerateRoom } from '../../services/roomPermissionService.js';
import { SocketUser } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { HandlerContext } from './types.js';

export const registerModerationHandlers = (ctx: HandlerContext): void => {
  const { io, socket, user, ensureUserInRoom, emitErrorAlert } = ctx;

  socket.on('getRoomParticipants', async () => {
    if (!ensureUserInRoom()) {
      socket.emit('error', { message: 'Not in a room' });
      return;
    }
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canModerateRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host or co-hosts can view participants' });
      return;
    }

    try {
      const sockets = await io.in(user.roomCode).fetchSockets();
      const seen = new Set<string>();
      const participants: Array<{
        userId: string;
        nickname: string;
        isMuted: boolean;
        isOwner: boolean;
        isCoHost: boolean;
      }> = [];

      for (const s of sockets) {
        const su = (s as any).data?.user as SocketUser | undefined;
        if (!su?.userId || seen.has(su.userId)) continue;
        seen.add(su.userId);
        participants.push({
          userId: su.userId,
          nickname: su.nickname || 'Anonymous',
          isMuted: isUserMuted(user.roomCode, su.userId),
          isOwner: !!(room?.ownerId && room.ownerId === su.userId),
          isCoHost: !!(room?.coHostIds?.includes(su.userId)),
        });
      }

      socket.emit('roomParticipants', {
        participants,
        mutedUserIds: getMutedUserIds(user.roomCode),
        ownerId: room?.ownerId,
        coHostIds: room?.coHostIds || [],
        slowModeMessagesPerMinute: room?.slowModeMessagesPerMinute ?? 0,
        participantsCanSend: room?.participantsCanSend !== false,
      });
    } catch (error) {
      emitErrorAlert(error, 'Failed to list participants');
    }
  });

  socket.on('muteUser', async (data: { userId: string }) => {
    if (!ensureUserInRoom() || !data?.userId) return;
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canModerateRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host or co-hosts can mute users' });
      return;
    }
    if (data.userId === authUserId) {
      socket.emit('error', { message: 'Cannot mute yourself' });
      return;
    }
    if (room?.ownerId === data.userId) {
      socket.emit('error', { message: 'Cannot mute the host' });
      return;
    }

    muteUser(user.roomCode, data.userId);
    io.to(user.roomCode).emit('userMuted', { userId: data.userId, roomId: user.roomCode });
    logger.info('User muted', { roomCode: user.roomCode, userId: data.userId, by: authUserId });
  });

  socket.on('unmuteUser', async (data: { userId: string }) => {
    if (!ensureUserInRoom() || !data?.userId) return;
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canModerateRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host or co-hosts can unmute users' });
      return;
    }

    unmuteUser(user.roomCode, data.userId);
    io.to(user.roomCode).emit('userUnmuted', { userId: data.userId, roomId: user.roomCode });
    logger.info('User unmuted', { roomCode: user.roomCode, userId: data.userId, by: authUserId });
  });

  socket.on('kickUser', async (data: { userId: string }) => {
    if (!ensureUserInRoom() || !data?.userId) return;
    const authUserId = socket.handshake.auth?.userId || user.userId;
    const room = await getRoomByCode(user.roomCode);
    if (!canModerateRoom(room, authUserId)) {
      socket.emit('error_unauthorized', { message: 'Only the host or co-hosts can remove users' });
      return;
    }
    if (data.userId === authUserId) {
      socket.emit('error', { message: 'Cannot remove yourself' });
      return;
    }
    if (room?.ownerId === data.userId) {
      socket.emit('error', { message: 'Cannot remove the host' });
      return;
    }

    kickUser(user.roomCode, data.userId);

    const sockets = await io.in(user.roomCode).fetchSockets();
    for (const s of sockets) {
      const su = (s as any).data?.user as SocketUser | undefined;
      if (su?.userId === data.userId) {
        s.emit('user_kicked', {
          roomId: user.roomCode,
          reason: 'Removed by host',
        });
        s.leave(user.roomCode);
      }
    }

    io.to(user.roomCode).emit('userKicked', {
      userId: data.userId,
      roomId: user.roomCode,
    });
    logger.info('User kicked', { roomCode: user.roomCode, userId: data.userId, by: authUserId });
  });
};
