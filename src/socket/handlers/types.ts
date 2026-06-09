import { Server, Socket } from 'socket.io';
import { SocketUser, Message } from '../../types/index.js';

export interface HandlerContext {
  io: Server;
  socket: Socket;
  user: SocketUser;
  typingUsers: Map<string, NodeJS.Timeout>;
  ensureUserInRoom: () => boolean;
  emitErrorAlert: (error: any, defaultMessage: string) => void;
}

export const normalizeMessageType = (message: Message): Message => {
  if (message.type === 'file' && message.fileMeta?.mimeType) {
    if (message.fileMeta.mimeType.startsWith('image/')) {
      return { ...message, type: 'image' as any };
    }
    if (message.fileMeta.mimeType.startsWith('video/')) {
      return { ...message, type: 'video' as any };
    }
  }
  return message;
};

export const normalizeMessages = (messages: Message[]): Message[] => {
  return messages.map(normalizeMessageType);
};

/** Shrink join/sync payloads so large base64 file bodies do not exceed Socket.IO limits. */
export const stripHeavyContentForJoin = (messages: Message[]): Message[] => {
  return normalizeMessages(messages).map((message) => {
    const content = message.content || '';
    const hasEmbeddedDataUrl =
      content.startsWith('data:') || content.includes('](data:');
    if (!hasEmbeddedDataUrl || content.length <= 2048) {
      return message;
    }

    const placeholder =
      message.fileMeta?.url ||
      (message.fileMeta?.name ? `[File: ${message.fileMeta.name}]` : '[File]');
    return { ...message, content: placeholder };
  });
};
