import {
  ALL_PATTERNED_ROOM_CODES,
  generatePatternedRoomCode,
  matchesRoomCodePattern,
} from '../roomCode.js';

describe('matchesRoomCodePattern', () => {
  it('accepts xxxx codes', () => {
    expect(matchesRoomCodePattern('0000')).toBe(true);
    expect(matchesRoomCodePattern('7777')).toBe(true);
  });

  it('accepts xyyy codes', () => {
    expect(matchesRoomCodePattern('1222')).toBe(true);
    expect(matchesRoomCodePattern('3000')).toBe(true);
  });

  it('accepts xxyy codes', () => {
    expect(matchesRoomCodePattern('1122')).toBe(true);
    expect(matchesRoomCodePattern('9900')).toBe(true);
  });

  it('accepts xxxy codes', () => {
    expect(matchesRoomCodePattern('1112')).toBe(true);
    expect(matchesRoomCodePattern('0009')).toBe(true);
  });

  it('accepts xyxy codes', () => {
    expect(matchesRoomCodePattern('1212')).toBe(true);
    expect(matchesRoomCodePattern('9090')).toBe(true);
  });

  it('rejects codes that do not match any pattern', () => {
    expect(matchesRoomCodePattern('1234')).toBe(false);
    expect(matchesRoomCodePattern('1123')).toBe(false);
    expect(matchesRoomCodePattern('1213')).toBe(false);
    expect(matchesRoomCodePattern('123')).toBe(false);
    expect(matchesRoomCodePattern('12345')).toBe(false);
    expect(matchesRoomCodePattern('abcd')).toBe(false);
  });
});

describe('ALL_PATTERNED_ROOM_CODES', () => {
  it('contains only valid 4-digit patterned codes', () => {
    expect(ALL_PATTERNED_ROOM_CODES.length).toBeGreaterThan(0);
    for (const code of ALL_PATTERNED_ROOM_CODES) {
      expect(code).toMatch(/^\d{4}$/);
      expect(matchesRoomCodePattern(code)).toBe(true);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_PATTERNED_ROOM_CODES).size).toBe(ALL_PATTERNED_ROOM_CODES.length);
  });
});

describe('generatePatternedRoomCode', () => {
  it('always produces a 4-digit code matching one of the five patterns', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePatternedRoomCode();
      expect(code).toMatch(/^\d{4}$/);
      expect(matchesRoomCodePattern(code)).toBe(true);
    }
  });
});
