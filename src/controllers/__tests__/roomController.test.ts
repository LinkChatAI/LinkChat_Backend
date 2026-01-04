import { Request, Response } from 'express';
import {
  createRoomHandler,
  getRoomHandler,
  generateUploadUrlHandler,
  generatePairingCodeHandler,
  validatePairingCodeHandler,
} from '../roomController.js';
import { createRoom, getRoomBySlugOrCode } from '../../services/roomService.js';
import { generatePairingCodeForRoom, validatePairingCode } from '../../services/pairingService.js';

jest.mock('../../services/roomService.js');
jest.mock('../../services/pairingService.js');
jest.mock('../../services/gcsService.js', () => ({
  generateUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'http://test.com', filePath: 'test.txt' }),
  isFileUploadAvailable: jest.fn().mockReturnValue(true),
}));

describe('Room Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockRequest = {
      body: {},
      params: {},
      headers: {},
    };
    mockResponse = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe('createRoomHandler', () => {
    it('should create a room', async () => {
      mockRequest.body = { name: 'Test Room' };
      (createRoom as jest.Mock).mockResolvedValue({
        code: '1234',
        token: 'test-token',
        name: 'Test Room',
        expiresAt: new Date(),
      });

      await createRoomHandler(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: '1234' })
      );
    });
  });

  describe('getRoomHandler', () => {
    it('should get room by code', async () => {
      mockRequest.params = { slugOrCode: '1234' };
      (getRoomBySlugOrCode as jest.Mock).mockResolvedValue({
        code: '1234',
        expiresAt: new Date(Date.now() + 3600000),
      });

      await getRoomHandler(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalled();
    });
  });

  describe('generatePairingCodeHandler', () => {
    it('should generate pairing code', async () => {
      mockRequest.params = { code: '1234' };
      mockRequest.body = { userId: 'user-123' };
      (generatePairingCodeForRoom as jest.Mock).mockResolvedValue('123456');

      await generatePairingCodeHandler(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith({ pairingCode: '123456' });
    });
  });

  describe('validatePairingCodeHandler', () => {
    it('should validate pairing code', async () => {
      mockRequest.body = { pairingCode: '123456' };
      (validatePairingCode as jest.Mock).mockResolvedValue({
        roomCode: '1234',
        userId: 'user-123',
      });

      await validatePairingCodeHandler(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.json).toHaveBeenCalledWith({
        roomCode: '1234',
        userId: 'user-123',
      });
    });
  });
});
