import { Server, Socket } from 'socket.io';
import { handleSocketConnection } from '../handlers';
import { getRoomByCode } from '../../services/roomService';
import { getRedisClient } from '../../config/redis';

jest.mock('../../services/roomService');
jest.mock('../../config/redis');
jest.mock('../../services/messageService');
jest.mock('../../services/gcsService');

describe('Socket Handlers', () => {
  let mockIo: Partial<Server>;
  let mockSocket: Partial<Socket>;
  let mockEmit: jest.Mock;
  let mockJoin: jest.Mock;
  let mockLeave: jest.Mock;
  let mockTo: jest.Mock;
  let mockOn: jest.Mock;
  let mockRedis: any;
  let eventHandlers: Map<string, Function>;

  beforeEach(() => {
    mockEmit = jest.fn();
    mockJoin = jest.fn();
    mockLeave = jest.fn();
    mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
    eventHandlers = new Map();

    mockOn = jest.fn((event: string, handler: Function) => {
      eventHandlers.set(event, handler);
    });

    mockSocket = {
      id: 'socket-123',
      emit: mockEmit,
      join: mockJoin,
      leave: mockLeave,
      to: mockTo,
      on: mockOn,
    };

    mockIo = {
      to: mockTo,
    };

    mockRedis = {
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      scard: jest.fn().mockResolvedValue(1),
      hset: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };

    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);
  });

  describe('joinRoom', () => {
    it('should join a valid room', async () => {
      const mockRoom = {
        code: '1234',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      };

      (getRoomByCode as jest.Mock).mockResolvedValue(mockRoom);
      (require('../../services/messageService').getRoomMessages as jest.Mock).mockResolvedValue([]);

      handleSocketConnection(mockIo as Server, mockSocket as Socket);

      const joinRoomHandler = eventHandlers.get('joinRoom');
      expect(joinRoomHandler).toBeDefined();

      if (joinRoomHandler) {
        await joinRoomHandler({ code: '1234', nickname: 'TestUser' });
      }

      expect(getRoomByCode).toHaveBeenCalledWith('1234');
      expect(mockJoin).toHaveBeenCalledWith('1234');
    });

    it('should emit error for invalid room', async () => {
      (getRoomByCode as jest.Mock).mockResolvedValue(null);

      handleSocketConnection(mockIo as Server, mockSocket as Socket);

      const joinRoomHandler = eventHandlers.get('joinRoom');
      expect(joinRoomHandler).toBeDefined();

      if (joinRoomHandler) {
        await joinRoomHandler({ code: '9999' });
      }

      expect(mockEmit).toHaveBeenCalledWith('error', { message: 'Room not found' });
    });
  });

  describe('leaveRoom', () => {
    it('should emit error when not in a room', async () => {
      handleSocketConnection(mockIo as Server, mockSocket as Socket);

      const leaveRoomHandler = eventHandlers.get('leaveRoom');
      expect(leaveRoomHandler).toBeDefined();

      if (leaveRoomHandler) {
        await leaveRoomHandler();
      }

      expect(mockEmit).toHaveBeenCalledWith('error', { message: 'Not in a room' });
    });
  });

  describe('sendMessage', () => {
    it('should emit error when not in a room', async () => {
      handleSocketConnection(mockIo as Server, mockSocket as Socket);

      const sendMessageHandler = eventHandlers.get('sendMessage');
      expect(sendMessageHandler).toBeDefined();

      if (sendMessageHandler) {
        await sendMessageHandler({ content: 'Hello' });
      }

      expect(mockEmit).toHaveBeenCalledWith('error', { message: 'Not in a room' });
    });
  });

  describe('sendFileMeta', () => {
    it('should emit error when not in a room', async () => {
      handleSocketConnection(mockIo as Server, mockSocket as Socket);

      const sendFileMetaHandler = eventHandlers.get('sendFileMeta');
      expect(sendFileMetaHandler).toBeDefined();

      if (sendFileMetaHandler) {
        await sendFileMetaHandler({
          filePath: 'path/to/file.pdf',
          fileName: 'file.pdf',
          fileSize: 1024,
          mimeType: 'application/pdf',
        });
      }

      expect(mockEmit).toHaveBeenCalledWith('error', { message: 'Not in a room' });
    });
  });
});
