import { Server } from 'socket.io';
import { Socket } from 'socket.io';
import { handleSocketConnection } from '../handlers.js';
import { getRoomByCode } from '../../services/roomService.js';
import { createMessage, getRoomMessages } from '../../services/messageService.js';

jest.mock('../../services/roomService.js');
jest.mock('../../services/messageService.js');
jest.mock('../../config/redis.js', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  isRedisAvailable: jest.fn().mockReturnValue(false),
}));

describe('Socket Handlers', () => {
  let io: Server;
  let mockSocket: Partial<Socket>;

  beforeEach(() => {
    mockSocket = {
      id: 'test-socket-id',
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
      to: jest.fn().mockReturnThis(),
    };
    io = {
      sockets: {
        adapter: {
          rooms: {
            get: jest.fn().mockReturnValue({ size: 1 }),
          },
        },
      },
      to: jest.fn().mockReturnThis(),
    } as any;
    jest.clearAllMocks();
  });

  describe('joinRoom', () => {
    it('should join a room successfully', (done) => {
      (getRoomByCode as jest.Mock).mockResolvedValue({
        code: '1234',
        expiresAt: new Date(Date.now() + 3600000),
      });
      (getRoomMessages as jest.Mock).mockResolvedValue([]);

      handleSocketConnection(io as Server, mockSocket as Socket);
      
      const joinHandler = (mockSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'joinRoom'
      )?.[1];

      if (joinHandler) {
        joinHandler({ code: '1234', nickname: 'TestUser' });
        setTimeout(() => {
          expect(mockSocket.join).toHaveBeenCalledWith('1234');
          expect(mockSocket.emit).toHaveBeenCalledWith('roomJoined', expect.any(Object));
          done();
        }, 100);
      } else {
        done(new Error('joinRoom handler not found'));
      }
    });

    it('should reject invalid room code', (done) => {
      handleSocketConnection(io as Server, mockSocket as Socket);
      
      const joinHandler = (mockSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'joinRoom'
      )?.[1];

      if (joinHandler) {
        joinHandler({ code: '' });
        setTimeout(() => {
          expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.any(String) }));
          done();
        }, 100);
      } else {
        done(new Error('joinRoom handler not found'));
      }
    });
  });

  describe('sendMessage', () => {
    it('should send a message', (done) => {
      (createMessage as jest.Mock).mockResolvedValue({
        id: 'msg-123',
        content: 'Hello',
        userId: 'user-123',
        nickname: 'TestUser',
        roomCode: '1234',
        type: 'text',
        createdAt: new Date(),
      });

      handleSocketConnection(io as Server, mockSocket as Socket);
      
      // First join room
      const joinHandler = (mockSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'joinRoom'
      )?.[1];
      
      if (joinHandler) {
        (getRoomByCode as jest.Mock).mockResolvedValue({
          code: '1234',
          expiresAt: new Date(Date.now() + 3600000),
        });
        (getRoomMessages as jest.Mock).mockResolvedValue([]);
        
        joinHandler({ code: '1234' });
        
        setTimeout(() => {
          const sendHandler = (mockSocket.on as jest.Mock).mock.calls.find(
            (call) => call[0] === 'sendMessage'
          )?.[1];
          
          if (sendHandler) {
            sendHandler({ content: 'Hello' });
            setTimeout(() => {
              expect(createMessage).toHaveBeenCalled();
              done();
            }, 100);
          } else {
            done(new Error('sendMessage handler not found'));
          }
        }, 100);
      } else {
        done(new Error('joinRoom handler not found'));
      }
    });
  });
});
