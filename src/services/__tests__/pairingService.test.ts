import { generatePairingCodeForRoom, validatePairingCode } from '../pairingService.js';
import { getRoomByCode } from '../roomService.js';
import { getRedisClient, isRedisAvailable } from '../../config/redis.js';

jest.mock('../roomService.js', () => ({
  getRoomByCode: jest.fn(),
}));
jest.mock('../../config/redis.js', () => ({
  getRedisClient: jest.fn(),
  isRedisAvailable: jest.fn(),
}));

const mockRedis = {
  exists: jest.fn(),
  setex: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
};

describe('Pairing Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);
    (isRedisAvailable as jest.Mock).mockReturnValue(true);
  });

  describe('generatePairingCodeForRoom', () => {
    it('should generate a pairing code', async () => {
      (getRoomByCode as jest.Mock).mockResolvedValue({
        code: '1234',
        expiresAt: new Date(Date.now() + 3600000),
      });
      mockRedis.exists.mockResolvedValue(0);

      const code = await generatePairingCodeForRoom('1234', 'user-123');
      
      expect(code).toHaveLength(6);
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should throw if room not found', async () => {
      (getRoomByCode as jest.Mock).mockResolvedValue(null);

      await expect(generatePairingCodeForRoom('1234', 'user-123')).rejects.toThrow('Room not found');
    });

    it('should throw if Redis not available', async () => {
      (isRedisAvailable as jest.Mock).mockReturnValue(false);

      await expect(generatePairingCodeForRoom('1234', 'user-123')).rejects.toThrow('Redis not available');
    });
  });

  describe('validatePairingCode', () => {
    it('should validate a pairing code', async () => {
      const pairingData = {
        roomCode: '1234',
        userId: 'user-123',
        createdAt: Date.now(),
      };
      
      mockRedis.get.mockResolvedValue(JSON.stringify(pairingData));
      (getRoomByCode as jest.Mock).mockResolvedValue({
        code: '1234',
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await validatePairingCode('123456');
      
      expect(result).toEqual({ roomCode: '1234', userId: 'user-123' });
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('should return null for invalid code', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await validatePairingCode('123456');
      
      expect(result).toBeNull();
    });
  });
});

