import { generateSlug, generateUniqueSlug, extractCodeFromSlug, isNumericCode } from '../utils/slug';

describe('Slug utilities', () => {
  describe('generateSlug', () => {
    it('should convert text to lowercase slug', () => {
      expect(generateSlug('Team Sync')).toBe('team-sync');
    });

    it('should remove special characters', () => {
      expect(generateSlug('Team@Sync!')).toBe('teamsync');
    });

    it('should replace spaces with hyphens', () => {
      expect(generateSlug('Team Sync Room')).toBe('team-sync-room');
    });

    it('should handle empty strings', () => {
      expect(generateSlug('')).toBe('');
    });
  });

  describe('generateUniqueSlug', () => {
    it('should append code to slug', () => {
      expect(generateUniqueSlug('Team Sync', '8321')).toBe('team-sync-8321');
    });

    it('should return code if base slug is empty', () => {
      expect(generateUniqueSlug('', '8321')).toBe('8321');
    });
  });

  describe('extractCodeFromSlug', () => {
    it('should extract code from slug', () => {
      expect(extractCodeFromSlug('team-sync-8321')).toBe('8321');
    });

    it('should return null if no code found', () => {
      expect(extractCodeFromSlug('team-sync')).toBeNull();
    });
  });

  describe('isNumericCode', () => {
    it('should return true for numeric codes', () => {
      expect(isNumericCode('8321')).toBe(true);
      expect(isNumericCode('1234')).toBe(true);
    });

    it('should return false for non-numeric strings', () => {
      expect(isNumericCode('team-sync')).toBe(false);
      expect(isNumericCode('abc')).toBe(false);
    });
  });
});
