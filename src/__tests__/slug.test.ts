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
    it('should prefix with linkchat and append code', () => {
      expect(generateUniqueSlug('Team Sync', '8321')).toBe('linkchat-team-sync-8321');
    });

    it('should use linkchat-code when base slug is empty', () => {
      expect(generateUniqueSlug('', '8321')).toBe('linkchat-8321');
    });

    it('should not double the linkchat prefix', () => {
      expect(generateUniqueSlug('LinkChat Party', '8321')).toBe('linkchat-party-8321');
    });
  });

  describe('extractCodeFromSlug', () => {
    it('should extract code from slug', () => {
      expect(extractCodeFromSlug('linkchat-team-sync-8321')).toBe('8321');
    });

    it('should extract code from legacy slugs without prefix', () => {
      expect(extractCodeFromSlug('team-sync-8321')).toBe('8321');
    });

    it('should return null if no code found', () => {
      expect(extractCodeFromSlug('linkchat-team-sync')).toBeNull();
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
