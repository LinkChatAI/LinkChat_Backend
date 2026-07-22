import { addReaction, removeReaction } from '../../services/messageService.js';
import { HandlerContext } from './types.js';

export const registerReactionHandlers = (ctx: HandlerContext): void => {
  const { io, socket, user, ensureUserInRoom, emitErrorAlert } = ctx;

  socket.on('addReaction', async (data: { messageId: string; emoji: string }) => {
    try {
      if (!ensureUserInRoom()) {
        socket.emit('error_alert', { message: 'Not in a room' });
        return;
      }

      // A reaction broadcasts the acting userId to the whole room — Ghost
      // Mode must never surface that identity, so participation is blocked
      // outright rather than attempted and filtered.
      if (user.isGhost) {
        socket.emit('error_alert', { message: 'Ghost Mode is read-only — reactions are disabled.' });
        return;
      }

      if (
        !data || typeof data !== 'object' ||
        typeof data.messageId !== 'string' || !data.messageId.trim() ||
        typeof data.emoji !== 'string' || !data.emoji.trim()
      ) {
        socket.emit('error_alert', { message: 'Invalid reaction data' });
        return;
      }

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

      if (user.isGhost) {
        socket.emit('error_alert', { message: 'Ghost Mode is read-only — reactions are disabled.' });
        return;
      }

      if (
        !data || typeof data !== 'object' ||
        typeof data.messageId !== 'string' || !data.messageId.trim() ||
        typeof data.emoji !== 'string' || !data.emoji.trim()
      ) {
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
};
