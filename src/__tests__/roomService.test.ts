import { createRoom, getRoomByCode, getRoomBySlugOrCode } from '../services/roomService';
import { RoomModel } from '../models/Room';
import { generateRoomCode } from '../utils/roomCode';

jest.mock('../models/Room');
jest.mock('../utils/roomCode');
jest.mock('../utils/jwt', () => ({
  generateToken: jest.fn(() => 'mock-token'),
}));

describe('Room Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createRoom', () => {
    it('should create a room without name', async () => {
      const mockCode = '1234';
      (generateRoomCode as jest.Mock).mockResolvedValue(mockCode);
      
      const mockRoom = {
        code: mockCode,
        token: 'mock-token',
        expiresAt: new Date(),
        participants: [],
        save: jest.fn().mockResolvedValue(true),
        toObject: jest.fn().mockReturnValue({
          code: mockCode,
          token: 'mock-token',
          expiresAt: new Date(),
          participants: [],
        }),
      };

      (RoomModel as any).mockImplementation(() => mockRoom);
      (RoomModel.findOne as jest.Mock).mockResolvedValue(null);

      const room = await createRoom();

      expect(room.code).toBe(mockCode);
      expect(mockRoom.save).toHaveBeenCalled();
    });

    it('should create a room with name and generate slug', async () => {
      const mockCode = '1234';
      (generateRoomCode as jest.Mock).mockResolvedValue(mockCode);
      
      const mockRoom = {
        code: mockCode,
        token: 'mock-token',
        name: 'Team Sync',
        slug: 'team-sync-1234',
        expiresAt: new Date(),
        participants: [],
        save: jest.fn().mockResolvedValue(true),
        toObject: jest.fn().mockReturnValue({
          code: mockCode,
          name: 'Team Sync',
          slug: 'team-sync-1234',
          token: 'mock-token',
          expiresAt: new Date(),
          participants: [],
        }),
      };

      (RoomModel as any).mockImplementation(() => mockRoom);
      (RoomModel.findOne as jest.Mock).mockResolvedValue(null);

      const room = await createRoom({ name: 'Team Sync' });

      expect(room.name).toBe('Team Sync');
      expect(room.slug).toBeDefined();
      expect(mockRoom.save).toHaveBeenCalled();
    });
  });

  describe('getRoomBySlugOrCode', () => {
    it('should find room by numeric code', async () => {
      const mockRoom = { code: '1234', toObject: () => ({ code: '1234' }) };
      (RoomModel.findOne as jest.Mock).mockResolvedValue(mockRoom);

      const room = await getRoomBySlugOrCode('1234');

      expect(room).toBeDefined();
      expect(room?.code).toBe('1234');
    });

    it('should find room by slug', async () => {
      const mockRoom = { code: '1234', slug: 'team-sync-1234', toObject: () => ({ code: '1234', slug: 'team-sync-1234' }) };
      (RoomModel.findOne as jest.Mock)
        .mockResolvedValueOnce(null) // First call for numeric code check
        .mockResolvedValueOnce(mockRoom); // Second call for slug check

      const room = await getRoomBySlugOrCode('team-sync-1234');

      expect(room).toBeDefined();
      expect(room?.slug).toBe('team-sync-1234');
    });
  });
});
