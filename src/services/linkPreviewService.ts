import { logger } from '../utils/logger.js';
import { getRedisClient, isRedisAvailable } from '../config/redis.js';

export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
}

interface CacheEntry {
  data: LinkPreviewData | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REDIS_CACHE_TTL_S = 60 * 60; // 1 hour in seconds (for Redis EX)
const MAX_CACHE_SIZE = 500;
const previewCache = new Map<string, CacheEntry>();

// Per-IP rate limit: max 20 previews per minute
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(clientKey: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(clientKey);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(clientKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

async function getCached(url: string): Promise<LinkPreviewData | null | undefined> {
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      const raw = await redis.get(`link_preview:${url}`);
      if (raw === null) return undefined; // Not in Redis cache
      if (raw === '') return null;         // Negative cache hit
      return JSON.parse(raw) as LinkPreviewData;
    } catch {
      // Fall through to in-memory cache on Redis error
    }
  }
  // In-memory fallback
  const entry = previewCache.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    previewCache.delete(url);
    return undefined;
  }
  return entry.data;
}

async function setCache(url: string, data: LinkPreviewData | null): Promise<void> {
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      // Store empty string as a sentinel for negative cache (null preview)
      const value = data === null ? '' : JSON.stringify(data);
      await redis.set(`link_preview:${url}`, value, 'EX', REDIS_CACHE_TTL_S);
    } catch {
      // Non-fatal: fall through to in-memory cache
    }
  }
  // Always also update in-memory cache as a fast local layer
  if (previewCache.size >= MAX_CACHE_SIZE) {
    const firstKey = previewCache.keys().next().value;
    if (firstKey) previewCache.delete(firstKey);
  }
  previewCache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function extractMeta(html: string, property: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function isValidPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchWithRedirects(url: string, maxRedirects = 2): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkChatBot/1.0; +https://linkchat.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
    });

    if ([301, 302, 303, 307, 308].includes(response.status) && maxRedirects > 0) {
      const location = response.headers.get('location');
      if (location) {
        const nextUrl = resolveUrl(url, location);
        if (isValidPreviewUrl(nextUrl)) {
          return fetchWithRedirects(nextUrl, maxRedirects - 1);
        }
      }
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLinkPreview(url: string, clientKey: string): Promise<LinkPreviewData | null> {
  if (!isValidPreviewUrl(url)) return null;
  if (!checkRateLimit(clientKey)) {
    throw new Error('Link preview rate limit exceeded. Please try again later.');
  }

  const cached = await getCached(url);
  if (cached !== undefined) return cached;

  try {
    const response = await fetchWithRedirects(url);

    if (!response.ok) {
      await setCache(url, null);
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      await setCache(url, null);
      return null;
    }

    const html = await response.text();
    const limitedHtml = html.slice(0, 100000);

    const title =
      extractMeta(limitedHtml, 'og:title') ||
      extractMeta(limitedHtml, 'twitter:title') ||
      limitedHtml.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();

    const description =
      extractMeta(limitedHtml, 'og:description') ||
      extractMeta(limitedHtml, 'twitter:description') ||
      extractMeta(limitedHtml, 'description');

    let image =
      extractMeta(limitedHtml, 'og:image') ||
      extractMeta(limitedHtml, 'twitter:image');

    if (image) image = resolveUrl(url, image);

    const preview: LinkPreviewData = {
      url,
      title: title?.slice(0, 200),
      description: description?.slice(0, 300),
      image,
    };

    await setCache(url, preview);
    return preview;
  } catch (error) {
    logger.debug('Link preview fetch failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    await setCache(url, null);
    return null;
  }
}
