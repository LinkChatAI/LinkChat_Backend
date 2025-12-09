import { createRoom, getRoomByCode } from '../roomService';
import { RoomModel } from '../../models/Room';

jest.mock('../../models/Room');
jest.mock('../../utils/roomCode', () => ({
  generateRoomCode: jest.fn().mockResolvedValue('1234'),
}));
jest.mock('../../utils/jwt', () => ({
  generateToken: jest.fn().mockReturnValue('test-token'),
}));

describe('RoomService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createRoom', () => {
    it('should create a room with code and token', async () => {
      const mockSave = jest.fn().mockResolvedValue(true);
      const mockRoom = {
        code: '1234',
        token: 'test-token',
        expiresAt: expect.any(Date),
        participants: [],
        save: mockSave,
        toObject: jest.fn().mockReturnValue({
          code: '1234',
          token: 'test-token',
          expiresAt: expect.any(Date),
          participants: [],
        }),
      };

      (RoomModel as jest.MockedClass<typeof RoomModel>).mockImplementation(() => mockRoom as any);

      const room = await createRoom();

      expect(room.code).toBe('1234');
      expect(room.token).toBe('test-token');
      expect(mockSave).toHaveBeenCalled();
    });
  });

  describe('getRoomByCode', () => {
    it('should return room if found', async () => {
      const mockRoom = {
        code: '1234',
        token: 'test-token',
        toObject: jest.fn().mockReturnValue({
          code: '1234',
          token: 'test-token',
        }),
      };

      (RoomModel.findOne as jest.Mock).mockResolvedValue(mockRoom);

      const room = await getRoomByCode('1234');

      expect(room).toBeTruthy();
      expect(room?.code).toBe('1234');
    });

    it('should return null if room not found', async () => {
      (RoomModel.findOne as jest.Mock).mockResolvedValue(null);

      const room = await getRoomByCode('9999');

      expect(room).toBeNull();
    });
  });
});

