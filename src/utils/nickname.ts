import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';
import { MessageModel } from '../models/Message.js';

// Fallback names array (warrior-like, metaphorical, gender-neutral, single-word, no numbers)
const FALLBACK_NAMES = [
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

/**
 * Generate a unique, gender-neutral nickname using Google Gemini API
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

    const prompt = 'Generate 1 creative, unique, warrior-like, metaphorical nickname for a chat user. The name should evoke strength, valor, and battle prowess. Examples: Blade, IronWill, StormLord, Valor, ShadowStrike. Must be gender-neutral, single-word, no numbers or special characters. Output ONLY the name.';

    // Set a timeout for the API call (5 seconds)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('API timeout')), 5000);
    });

    const apiCall = model.generateContent(prompt);
    const response = await Promise.race([apiCall, timeoutPromise]);
    
    const text = response.response.text().trim();
    
    // Validate the response - should be a single word, alphanumeric only
    const cleanedName = text.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
    
    if (cleanedName && cleanedName.length >= 3 && cleanedName.length <= 20) {
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
 * Generate a random 3-digit numeric suffix (e.g., #839)
 */
function generateSuffix(): string {
  return Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

/**
 * Get existing nicknames in a room from Redis and MongoDB
 * Returns a Set of lowercase nicknames for case-insensitive comparison
 * @param roomCode - The room code
 * @param excludeUserId - Optional userId to exclude from the check (for user refreshing with same nickname)
 * @param io - Optional Socket.IO server instance to check active sockets (not available in utils)
 */
async function getExistingNicknamesInRoom(roomCode: string, excludeUserId?: string, io?: any): Promise<Set<string>> {
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
 * Ensure nickname is unique in the room by appending suffix if needed
 * Exported for use in socket handlers when user provides their own nickname
 * @param baseNickname - The nickname to ensure uniqueness for
 * @param roomCode - The room code
 * @param excludeUserId - Optional userId to exclude from uniqueness check (for same user refreshing)
 */
export async function ensureUniqueNickname(baseNickname: string, roomCode: string, excludeUserId?: string): Promise<string> {
  const existingNicknames = await getExistingNicknamesInRoom(roomCode, excludeUserId);
  const baseLower = baseNickname.toLowerCase();

  // If nickname is already unique, return as-is
  if (!existingNicknames.has(baseLower)) {
    return baseNickname;
  }

  // Nickname exists, append suffix and check again (max 10 attempts)
  let attempts = 0;
  let uniqueNickname = baseNickname;
  
  while (attempts < 10) {
    const suffix = generateSuffix();
    uniqueNickname = `${baseNickname}#${suffix}`;
    
    if (!existingNicknames.has(uniqueNickname.toLowerCase())) {
      logger.debug('Nickname conflict resolved with suffix', {
        original: baseNickname,
        unique: uniqueNickname,
        roomCode,
      });
      return uniqueNickname;
    }
    
    attempts++;
  }

  // If still not unique after 10 attempts, append timestamp-based suffix
  const timestampSuffix = Date.now().toString(36).slice(-3).toUpperCase();
  uniqueNickname = `${baseNickname}-${timestampSuffix}`;
  
  logger.warn('Used timestamp suffix for nickname uniqueness', {
    original: baseNickname,
    unique: uniqueNickname,
    roomCode,
  });
  
  return uniqueNickname;
}

/**
 * Generate a unique nickname for a specific room using waterfall strategy:
 * 1. Try AI generation (Google Gemini)
 * 2. Fallback to random name from FALLBACK_NAMES
 * 3. Ensure uniqueness within the room by appending suffix if needed
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
