import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { MessageModel } from '../models/Message.js';

// Shared nickname format rules — every nickname in the app (auto-generated or
// user-set) must satisfy these. Keep in sync with the mirrored constants in
// frontend/src/utils/nicknameValidation.ts.
export const NICKNAME_MIN_LENGTH = 3;
export const NICKNAME_MAX_LENGTH = 10;
export const NICKNAME_PATTERN = /^[a-zA-Z0-9]+$/;

export function isValidNicknameFormat(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length >= NICKNAME_MIN_LENGTH &&
    name.length <= NICKNAME_MAX_LENGTH &&
    NICKNAME_PATTERN.test(name)
  );
}

export const NICKNAME_FORMAT_ERROR = `Nickname must be ${NICKNAME_MIN_LENGTH}-${NICKNAME_MAX_LENGTH} characters, letters and numbers only`;

// Warrior-like, metaphorical, unisex (gender-neutral), single-word names —
// filtered to NICKNAME_MAX_LENGTH so every auto-generated nickname is always
// editable back to itself under the same rule users' custom nicknames follow.
const ALL_FALLBACK_NAMES = [
  // Weapons & Armor
  'Blade', 'Sword', 'Shield', 'Arrow', 'Spear', 'Axe', 'Mace', 'Helm', 'Gauntlet',
  'BattleAxe', 'WarHammer', 'IronShield', 'SteelBlade', 'BloodSword', 'ShadowBow', 'FlameSpear',

  // Warrior Traits & Concepts
  'Valor', 'Honor', 'Might', 'Wrath', 'Fury', 'Courage', 'Glory', 'Vengeance', 'Rage', 'Pride',
  'IronWill', 'SteelSoul', 'FlameHeart', 'StoneGuard', 'BloodRage', 'ShadowStrike', 'DawnBreaker',
  'NightFury', 'StormLord', 'WarKing', 'BattleCry', 'IronFist', 'ThunderStrike', 'FireBrand',

  // Battle Concepts
  'Onslaught', 'Assault', 'Charge', 'Siege', 'Battle', 'War', 'Strike', 'Raid', 'Crusade',
  'Conquest', 'Victory', 'Triumph', 'Dominion', 'Reign', 'Empire', 'Legion', 'Battalion',

  // Mythical Warriors
  'Titan', 'TitanSlayer', 'DragonSlayer', 'BeastMaster', 'WarChief', 'BattleLord', 'Warlord',
  'IronJaw', 'BloodHound', 'WarHound', 'SteelWolf', 'BattleBear', 'WarEagle', 'CombatRaven',

  // Elemental Warriors
  'FlameWarrior', 'FrostKnight', 'StormRider', 'ThunderGod', 'IronThunder', 'FireStorm',
  'IceBlade', 'FlameStrike', 'FrostBite', 'StormHammer', 'ThunderClap', 'FireBreath',

  // Metaphorical Warriors
  'IronGuard', 'SteelVanguard', 'BloodGuardian', 'ShadowKnight', 'LightningStrike', 'PhoenixBlade',
  'VortexWarrior', 'NovaStrike', 'CosmicBlade', 'SolarWarrior', 'LunarKnight', 'StarStrike',

  // Powerful Single Words
  'Warlord', 'Warrior', 'Champion', 'Guardian', 'Defender', 'Protector', 'Sentinel', 'Vanguard',
  'Conqueror', 'Destroyer', 'Avenger', 'Executioner', 'Gladiator', 'Spartan', 'Viking', 'Samurai'
];

const FALLBACK_NAMES = ALL_FALLBACK_NAMES.filter((name) => isValidNicknameFormat(name));

/**
 * Fisher-Yates shuffle (does not mutate the input array).
 */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * A freshly shuffled copy of the curated fallback name pool — used by socket
 * handlers that need to walk fresh candidate names on a reservation conflict.
 */
export function shuffleNicknamePool(): string[] {
  return shuffle(FALLBACK_NAMES);
}

/**
 * Generate a unique, unisex nickname using Google Gemini API
 * Falls back to a random name from the fallback array if API fails
 */
export async function generateAiNickname(): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;

  // If no API key, use fallback immediately
  if (!apiKey) {
    logger.warn('GOOGLE_API_KEY not set, using fallback nickname');
    return getRandomFallbackName();
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

    const prompt = `Generate 1 creative, unisex (gender-neutral), warrior-like, metaphorical nickname for a chat user. The name should evoke strength, valor, and battle prowess. Examples: Blade, Valor, Storm, Titan, Rebel. Must be a single word of ${NICKNAME_MIN_LENGTH}-${NICKNAME_MAX_LENGTH} letters, no numbers, no spaces, and no special characters. Output ONLY the name.`;

    // Set a timeout for the API call (5 seconds)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('API timeout')), 5000);
    });

    const apiCall = model.generateContent(prompt);
    const response = await Promise.race([apiCall, timeoutPromise]);

    const text = response.response.text().trim();

    // Validate the response - should be a single word, alphanumeric only
    const cleanedName = text.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');

    if (isValidNicknameFormat(cleanedName)) {
      logger.debug('Generated AI nickname successfully', { nickname: cleanedName });
      return cleanedName;
    } else {
      logger.warn('AI generated invalid nickname, using fallback', { received: text });
      return getRandomFallbackName();
    }
  } catch (error: any) {
    // Log error but don't throw - always fallback
    logger.warn('Failed to generate AI nickname, using fallback', {
      error: error instanceof Error ? error.message : String(error)
    });
    return getRandomFallbackName();
  }
}

/**
 * Get a random name from the fallback array
 */
function getRandomFallbackName(): string {
  const randomIndex = Math.floor(Math.random() * FALLBACK_NAMES.length);
  return FALLBACK_NAMES[randomIndex];
}

/**
 * Get existing nicknames in a room from Redis and MongoDB
 * Returns a Set of lowercase nicknames for case-insensitive comparison
 * @param roomCode - The room code
 * @param excludeUserId - Optional userId to exclude from the check (for user refreshing with same nickname)
 */
async function getExistingNicknamesInRoom(roomCode: string, excludeUserId?: string): Promise<Set<string>> {
  const existingNicknames = new Set<string>();

  // Try Redis first (faster, but may not have all users)
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      const userIds = await redis.smembers(`room:${roomCode}:users`);
      if (userIds && userIds.length > 0) {
        const pipeline = redis.pipeline();
        userIds.forEach((userId: string) => {
          // Skip the excluded userId (user refreshing with same nickname)
          if (excludeUserId && userId === excludeUserId) {
            return;
          }
          pipeline.hget(`user:${userId}`, 'nickname');
        });
        const results = await pipeline.exec();

        if (results) {
          results.forEach((result: any) => {
            if (result && result[1] && typeof result[1] === 'string') {
              const nickname = result[1].trim();
              if (nickname && nickname !== 'Anonymous') {
                // Store lowercase for case-insensitive comparison
                existingNicknames.add(nickname.toLowerCase());
              }
            }
          });
        }
      }
    } catch (error: any) {
      logger.warn('Failed to get nicknames from Redis', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Also check MongoDB messages for nicknames (covers users who sent messages)
  // If excludeUserId is provided, exclude messages from that user
  try {
    const query: any = { roomCode };
    if (excludeUserId) {
      query.userId = { $ne: excludeUserId };
    }
    const distinctNicknames = await MessageModel.distinct('nickname', query).exec();
    distinctNicknames.forEach((nickname: any) => {
      if (nickname && typeof nickname === 'string' && nickname.trim() !== 'Anonymous') {
        existingNicknames.add(nickname.trim().toLowerCase());
      }
    });
  } catch (error: any) {
    logger.warn('Failed to get nicknames from MongoDB', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return existingNicknames;
}

/**
 * Ensure a nickname is unique in the room. Unlike the previous implementation,
 * this never appends a suffix to the requested name (that would break the
 * "one-word, letters-and-numbers-only" guarantee for auto-generated names) —
 * instead it walks a shuffled pool of fresh candidate names until it finds one
 * that isn't taken.
 *
 * This is only for the auto-generation path (no uniqueness guarantee is owed
 * to a name nobody asked for by exact spelling). Room joins/edits where a user
 * supplied their own nickname are handled separately in joinHandlers.ts, where
 * a conflict is surfaced as an error instead of being silently substituted.
 *
 * @param baseNickname - The first candidate to try (e.g. the AI/fallback pick)
 * @param roomCode - The room code
 * @param excludeUserId - Optional userId to exclude from uniqueness check (for same user refreshing)
 */
export async function ensureUniqueNickname(baseNickname: string, roomCode: string, excludeUserId?: string): Promise<string> {
  const existingNicknames = await getExistingNicknamesInRoom(roomCode, excludeUserId);

  if (!existingNicknames.has(baseNickname.toLowerCase())) {
    return baseNickname;
  }

  const pool = shuffle(FALLBACK_NAMES);
  for (const candidate of pool) {
    if (!existingNicknames.has(candidate.toLowerCase())) {
      logger.debug('Nickname conflict resolved with a fresh candidate name', {
        original: baseNickname,
        unique: candidate,
        roomCode,
      });
      return candidate;
    }
  }

  // Entire pool exhausted in this room (would require more concurrent
  // participants than distinct fallback names) — extend with a numeric
  // suffix so we still produce a compliant (letters+numbers, single token,
  // <=NICKNAME_MAX_LENGTH) nickname rather than fail.
  return appendNumericSuffixUntilUnique(baseNickname, existingNicknames);
}

/**
 * Last-resort uniqueness fallback: appends a numeric suffix (no separator, so
 * the result stays a single alphanumeric token) truncating the base as needed
 * to respect NICKNAME_MAX_LENGTH.
 */
function appendNumericSuffixUntilUnique(baseNickname: string, existingNicknames: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const suffix = String(Math.floor(Math.random() * 1000));
    const truncatedBase = baseNickname.slice(0, Math.max(1, NICKNAME_MAX_LENGTH - suffix.length));
    const candidate = `${truncatedBase}${suffix}`;
    if (!existingNicknames.has(candidate.toLowerCase())) {
      logger.warn('Fallback name pool exhausted, used numeric suffix for uniqueness', {
        original: baseNickname,
        unique: candidate,
      });
      return candidate;
    }
  }

  // Astronomically unlikely, but never return a colliding name.
  const suffix = Date.now().toString().slice(-4);
  return `${baseNickname.slice(0, Math.max(1, NICKNAME_MAX_LENGTH - suffix.length))}${suffix}`;
}

/**
 * Generate a unique nickname for a specific room using waterfall strategy:
 * 1. Try AI generation (Google Gemini)
 * 2. Fallback to random name from FALLBACK_NAMES
 * 3. Ensure uniqueness within the room by picking a fresh candidate name if needed
 *
 * @param roomCode - The room code to check uniqueness against
 * @returns A unique nickname guaranteed to be unique within the room
 */
export async function generateUniqueNicknameForRoom(roomCode: string): Promise<string> {
  let baseNickname: string;

  // Waterfall Strategy: Try AI first, then fallback
  try {
    baseNickname = await generateAiNickname();
  } catch (error: any) {
    logger.warn('AI nickname generation failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
      roomCode,
    });
    baseNickname = getRandomFallbackName();
  }

  // Ensure uniqueness within the room
  const uniqueNickname = await ensureUniqueNickname(baseNickname, roomCode);

  return uniqueNickname;
}
