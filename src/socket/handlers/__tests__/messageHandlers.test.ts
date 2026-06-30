import { registerMessageHandlers } from '../messageHandlers.js';
import { HandlerContext } from '../types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../../services/roomService.js', () => ({
  getRoomByCode: jest.fn(),
}));
jest.mock('../../../services/messageService.js', () => ({
  createMessage: jest.fn(),
  getMessagesAfterId: jest.fn(),
  getRoomMessages: jest.fn(),
  addReaction: jest.fn(),
  removeReaction: jest.fn(),
  editMessage: jest.fn(),
  pinMessage: jest.fn(),
  unpinMessage: jest.fn(),
  searchMessages: jest.fn(),
  getPinnedMessages: jest.fn(),
}));
jest.mock('../../../models/Message.js', () => ({
  MessageModel: {
    findOne: jest.fn(),
    deleteOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));
jest.mock('../../../middleware/rateLimiter.js', () => ({
  socketRateLimiter: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../services/roomModerationService.js', () => ({
  isUserMuted: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../services/roomPermissionService.js', () => ({
  canModerateRoom: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../services/slowModeService.js', () => ({
  checkSlowMode: jest.fn().mockReturnValue(true),
}));
jest.mock('../../adminHandlers.js', () => ({
  emitAdminInsightUpdate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../config/redis.js', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  isRedisAvailable: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../utils/validation.js', () => ({
  validateMessageSize: jest.fn().mockReturnValue({ valid: true }),
}));
jest.mock('../../../utils/logger.js', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../../../services/gcsService.js', () => ({
  getFileUrl: jest.fn().mockReturnValue('https://storage.example.com/file.pdf'),
  getImageUrl: jest.fn().mockResolvedValue('https://storage.example.com/image.jpg'),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type EventMap = Record<string, (...args: any[]) => any>;

// Mongoose query chain helper: findOne().lean().exec()
const makeQuery = (result: any) => ({
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(result),
});

const buildSocket = (overrides: Partial<{ userId: string; roomCode: string }> = {}) => {
  const handlers: EventMap = {};
  const emitted: Array<[string, unknown]> = [];

  const socket = {
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    emit: jest.fn((event: string, data: unknown) => { emitted.push([event, data]); }),
    handshake: { auth: { userId: overrides.userId ?? 'user-123' } },
    id: 'socket-abc',
  };

  return { socket, handlers, emitted };
};

const buildIo = () => {
  const emitMock = jest.fn();
  const toMock = jest.fn(() => ({ emit: emitMock }));
  return { io: { to: toMock } as any, broadcastEmit: emitMock };
};

const buildContext = (
  socket: any,
  io: any,
  roomCode = 'test-room',
  ensureUserInRoom = jest.fn().mockReturnValue(true),
): HandlerContext => ({
  io,
  socket,
  user: { userId: 'user-123', nickname: 'Alice', roomCode },
  typingUsers: new Map(),
  ensureUserInRoom,
  emitErrorAlert: jest.fn(),
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('registerMessageHandlers', () => {
  const { getRoomByCode } = require('../../../services/roomService.js');
  const { createMessage, getMessagesAfterId } = require('../../../services/messageService.js');
  const { MessageModel } = require('../../../models/Message.js');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── sync_messages ──────────────────────────────────────────────────────────

  describe('sync_messages', () => {
    it('returns gap-fill messages when user is in a room', async () => {
      const { socket, handlers } = buildSocket();
      const { io } = buildIo();
      const ctx = buildContext(socket, io);
      const fakeMsg = { id: 'msg-1', content: 'hello', roomCode: 'test-room', userId: 'user-123' };
      (getMessagesAfterId as jest.Mock).mockResolvedValue([fakeMsg]);

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sync_messages']({ lastMessageId: 'old-id' }, ack);

      expect(getMessagesAfterId).toHaveBeenCalledWith('test-room', 'old-id');
      expect(socket.emit).toHaveBeenCalledWith('messages_synced', expect.objectContaining({
        messages: expect.any(Array),
      }));
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('falls back to data.roomCode when user is not yet in a room (reconnect race)', async () => {
      const { socket, handlers } = buildSocket();
      const { io } = buildIo();
      // ensureUserInRoom returns false (not joined yet) but we still have data.roomCode
      const ctx = buildContext(socket, io, '', jest.fn().mockReturnValue(false));
      ctx.user.roomCode = ''; // not in room yet
      (getMessagesAfterId as jest.Mock).mockResolvedValue([]);

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sync_messages']({ lastMessageId: 'old-id', roomCode: 'room-999' }, ack);

      expect(getMessagesAfterId).toHaveBeenCalledWith('room-999', 'old-id');
      // No error_alert should be emitted (reconnect race must be silent)
      const emittedEvents = (socket.emit as jest.Mock).mock.calls.map(([e]: [string]) => e);
      expect(emittedEvents).not.toContain('error_alert');
    });

    it('fails silently (no error_alert) when neither user.roomCode nor data.roomCode are present', async () => {
      const { socket, handlers } = buildSocket();
      const { io } = buildIo();
      const ctx = buildContext(socket, io, '', jest.fn().mockReturnValue(false));
      ctx.user.roomCode = '';

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sync_messages']({}, ack);

      expect(getMessagesAfterId).not.toHaveBeenCalled();
      const emittedEvents = (socket.emit as jest.Mock).mock.calls.map(([e]: [string]) => e);
      expect(emittedEvents).not.toContain('error_alert');
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });
  });

  // ── sendMessage (text) ─────────────────────────────────────────────────────

  describe('sendMessage — text', () => {
    const makeRoom = (overrides = {}) => ({
      code: 'test-room',
      isLocked: false,
      participantsCanSend: true,
      slowModeMessagesPerMinute: 0,
      ownerId: 'owner-id',
      ...overrides,
    });

    it('broadcasts a text message to the room', async () => {
      const { socket, handlers } = buildSocket();
      const { io, broadcastEmit } = buildIo();
      const ctx = buildContext(socket, io);

      const fakeRoom = makeRoom();
      (getRoomByCode as jest.Mock).mockResolvedValue(fakeRoom);
      const savedMsg = { id: 'msg-new', content: 'hello', type: 'text', userId: 'user-123' };
      (createMessage as jest.Mock).mockResolvedValue(savedMsg);

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sendMessage']({ content: 'hello', type: 'text' }, ack);

      expect(createMessage).toHaveBeenCalled();
      expect(broadcastEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({ id: 'msg-new' }));
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('rejects empty content', async () => {
      const { socket, handlers } = buildSocket();
      const { io } = buildIo();
      const ctx = buildContext(socket, io);
      (getRoomByCode as jest.Mock).mockResolvedValue(makeRoom());

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sendMessage']({ content: '   ', type: 'text' }, ack);

      expect(createMessage).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('rejects when room is locked', async () => {
      const { socket, handlers } = buildSocket();
      const { io } = buildIo();
      const ctx = buildContext(socket, io);
      (getRoomByCode as jest.Mock).mockResolvedValue(makeRoom({ isLocked: true }));

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sendMessage']({ content: 'hi' }, ack);

      expect(createMessage).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('rejects when user is not in a room', async () => {
      const { socket, handlers } = buildSocket();
      const { io } = buildIo();
      const ctx = buildContext(socket, io, 'test-room', jest.fn().mockReturnValue(false));

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sendMessage']({ content: 'hi' }, ack);

      expect(createMessage).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('includes tempId in the broadcast so the client can reconcile optimistic messages', async () => {
      const { socket, handlers } = buildSocket();
      const { io, broadcastEmit } = buildIo();
      const ctx = buildContext(socket, io);
      (getRoomByCode as jest.Mock).mockResolvedValue(makeRoom());
      const savedMsg = { id: 'msg-real', content: 'hey', type: 'text', userId: 'user-123' };
      (createMessage as jest.Mock).mockResolvedValue(savedMsg);

      registerMessageHandlers(ctx);

      await handlers['sendMessage']({ content: 'hey', tempId: 'temp-abc' });

      const [, broadcastPayload] = broadcastEmit.mock.calls[0];
      expect((broadcastPayload as any).tempId).toBe('temp-abc');
    });
  });

  // ── sendMessage (file) ─────────────────────────────────────────────────────

  describe('sendMessage — file', () => {
    const makeRoom = () => ({
      code: 'test-room',
      isLocked: false,
      participantsCanSend: true,
      slowModeMessagesPerMinute: 0,
      ownerId: 'owner-id',
    });

    it('broadcasts a file message with resolved URL', async () => {
      const { socket, handlers } = buildSocket();
      const { io, broadcastEmit } = buildIo();
      const ctx = buildContext(socket, io);
      (getRoomByCode as jest.Mock).mockResolvedValue(makeRoom());
      // Mongoose query chain: findOne().lean().exec() → null (no duplicate)
      (MessageModel.findOne as jest.Mock).mockReturnValue(makeQuery(null));

      const savedMsg = {
        id: 'msg-file-1',
        type: 'file',
        content: 'Shared file: report.pdf',
        fileMeta: { name: 'report.pdf', size: 1024, url: 'https://storage.example.com/file.pdf', mimeType: 'application/pdf' },
        userId: 'user-123',
      };
      (createMessage as jest.Mock).mockResolvedValue(savedMsg);

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sendMessage']({
        content: 'Shared file: report.pdf',
        type: 'file',
        fileKey: 'rooms/test-room/uuid-report.pdf',
        fileMeta: { name: 'report.pdf', size: 1024, mimeType: 'application/pdf' },
        tempId: 'temp-file-1',
      }, ack);

      expect(createMessage).toHaveBeenCalled();
      expect(broadcastEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({
        type: 'file',
        fileMeta: expect.objectContaining({ name: 'report.pdf' }),
        tempId: 'temp-file-1',
      }));
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('rejects file message with invalid fileMeta', async () => {
      const { socket, handlers } = buildSocket();
      const { io } = buildIo();
      const ctx = buildContext(socket, io);
      (getRoomByCode as jest.Mock).mockResolvedValue(makeRoom());

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sendMessage']({
        content: 'file',
        type: 'file',
        fileKey: 'rooms/test-room/file.pdf',
        fileMeta: { name: 'file.pdf' }, // missing size and mimeType
      }, ack);

      expect(createMessage).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('deduplicates file messages sent within 10 seconds', async () => {
      const { socket, handlers } = buildSocket();
      const { io, broadcastEmit } = buildIo();
      const ctx = buildContext(socket, io);
      (getRoomByCode as jest.Mock).mockResolvedValue(makeRoom());

      const existingMsg = {
        id: 'msg-existing',
        type: 'file',
        content: 'Shared file: report.pdf',
        fileMeta: { name: 'report.pdf', size: 1024, url: 'https://...', mimeType: 'application/pdf' },
        userId: 'user-123',
      };
      // Mongoose query chain: findOne().lean().exec() → existingMsg (duplicate found)
      (MessageModel.findOne as jest.Mock).mockReturnValue(makeQuery(existingMsg));

      registerMessageHandlers(ctx);

      const ack = jest.fn();
      await handlers['sendMessage']({
        content: 'Shared file: report.pdf',
        type: 'file',
        fileKey: 'rooms/test-room/uuid-report.pdf',
        fileMeta: { name: 'report.pdf', size: 1024, mimeType: 'application/pdf' },
      }, ack);

      // Should re-broadcast existing message, not create a new one
      expect(createMessage).not.toHaveBeenCalled();
      expect(broadcastEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({ id: 'msg-existing' }));
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  // ── deleteMessage ──────────────────────────────────────────────────────────

  describe('deleteMessage', () => {
    it('allows users to delete their own messages', async () => {
      const { socket, handlers } = buildSocket({ userId: 'user-123' });
      const { io, broadcastEmit } = buildIo();
      const ctx = buildContext(socket, io);

      const msg = { id: 'msg-1', userId: 'user-123', type: 'text', fileMeta: null };
      (MessageModel.findOne as jest.Mock).mockResolvedValue(msg);
      (getRoomByCode as jest.Mock).mockResolvedValue({ code: 'test-room', ownerId: 'owner-99' });
      (MessageModel.deleteOne as jest.Mock).mockResolvedValue({ deletedCount: 1 });
      const { canModerateRoom } = require('../../../services/roomPermissionService.js');
      (canModerateRoom as jest.Mock).mockReturnValue(false);

      registerMessageHandlers(ctx);

      await handlers['deleteMessage']({ messageId: 'msg-1' });

      expect(MessageModel.deleteOne).toHaveBeenCalledWith({ id: 'msg-1' });
      expect(broadcastEmit).toHaveBeenCalledWith('messageDeleted', expect.objectContaining({
        messageId: 'msg-1',
        deletedByAdmin: false,
      }));
    });

    it('prevents deleting another user\'s message without moderation rights', async () => {
      const { socket, handlers } = buildSocket({ userId: 'user-123' });
      const { io } = buildIo();
      const ctx = buildContext(socket, io);

      const msg = { id: 'msg-2', userId: 'other-user', type: 'text', fileMeta: null };
      (MessageModel.findOne as jest.Mock).mockResolvedValue(msg);
      (getRoomByCode as jest.Mock).mockResolvedValue({ code: 'test-room', ownerId: 'owner-99' });
      const { canModerateRoom } = require('../../../services/roomPermissionService.js');
      (canModerateRoom as jest.Mock).mockReturnValue(false);

      registerMessageHandlers(ctx);

      await handlers['deleteMessage']({ messageId: 'msg-2' });

      expect(MessageModel.deleteOne).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('error_alert', expect.objectContaining({ message: expect.stringMatching(/unauthorized/i) }));
    });
  });
});
