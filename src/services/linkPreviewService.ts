import { logger } from '../utils/logger.js';

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

function getCached(url: string): LinkPreviewData | null | undefined {
  const entry = previewCache.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    previewCache.delete(url);
    return undefined;
  }
  return entry.data;
}

function setCache(url: string, data: LinkPreviewData | null): void {
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
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function fetchLinkPreview(url: string, clientKey: string): Promise<LinkPreviewData | null> {
  if (!isValidPreviewUrl(url)) {
    return null;
  }

  if (!checkRateLimit(clientKey)) {
    throw new Error('Link preview rate limit exceeded. Please try again later.');
  }

  const cached = getCached(url);
  if (cached !== undefined) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkChatBot/1.0; +https://linkchat.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) {
      setCache(url, null);
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      setCache(url, null);
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

    if (image) {
      image = resolveUrl(url, image);
    }

    const preview: LinkPreviewData = {
      url,
      title: title?.slice(0, 200),
      description: description?.slice(0, 300),
      image,
    };

    setCache(url, preview);
    return preview;
  } catch (error) {
    logger.debug('Link preview fetch failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    setCache(url, null);
    return null;
  }
}
