import { Request, Response } from 'express';
import { createRoomHandler, getRoomHandler } from '../roomController';
import { createRoom, getRoomByCode } from '../../services/roomService';

jest.mock('../../services/roomService');

describe('RoomController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;

  beforeEach(() => {
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockResponse = {
      json: mockJson,
      status: mockStatus,
    };
    mockRequest = {};
  });

  describe('createRoomHandler', () => {
    it('should create a room and return code and token', async () => {
      const mockRoom = {
        code: '1234',
        token: 'test-token',
        expiresAt: new Date(),
      };

      (createRoom as jest.Mock).mockResolvedValue(mockRoom);

      await createRoomHandler(mockRequest as Request, mockResponse as Response);

      expect(createRoom).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith({
        code: '1234',
        token: 'test-token',
        expiresAt: mockRoom.expiresAt,
      });
    });

    it('should handle errors', async () => {
      (createRoom as jest.Mock).mockRejectedValue(new Error('Database error'));

      await createRoomHandler(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Failed to create room' });
    });
  });

  describe('getRoomHandler', () => {
    it('should return room details', async () => {
      const mockRoom = {
        code: '1234',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        participants: ['user1', 'user2'],
      };

      mockRequest.params = { code: '1234' };
      (getRoomByCode as jest.Mock).mockResolvedValue(mockRoom);

      await getRoomHandler(mockRequest as Request, mockResponse as Response);

      expect(getRoomByCode).toHaveBeenCalledWith('1234');
      expect(mockJson).toHaveBeenCalledWith({
        code: '1234',
        createdAt: mockRoom.createdAt,
        expiresAt: mockRoom.expiresAt,
        participantCount: 2,
      });
    });

    it('should return 404 if room not found', async () => {
      mockRequest.params = { code: '9999' };
      (getRoomByCode as jest.Mock).mockResolvedValue(null);

      await getRoomHandler(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Room not found' });
    });

    it('should return 410 if room expired', async () => {
      const mockRoom = {
        code: '1234',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
        participants: [],
      };

      mockRequest.params = { code: '1234' };
      (getRoomByCode as jest.Mock).mockResolvedValue(mockRoom);

      await getRoomHandler(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(410);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Room expired' });
    });
  });
});
