/**
 * Generate a URL-safe slug from a string
 */
export const generateSlug = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/[\s_-]+/g, '-') // Replace spaces/underscores with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
};

/**
 * Generate a unique slug by appending a random suffix
 */
export const generateUniqueSlug = (baseSlug: string, code: string): string => {
  const cleanBase = generateSlug(baseSlug);
  if (!cleanBase) {
    return code;
  }
  return `${cleanBase}-${code}`;
};

/**
 * Extract room code from a slug (e.g., "team-sync-8321" -> "8321")
 */
export const extractCodeFromSlug = (slug: string): string | null => {
  const match = slug.match(/-(\d+)$/);
  return match ? match[1] : null;
};

/**
 * Check if a string is a numeric room code
 */
export const isNumericCode = (input: string): boolean => {
  return /^\d+$/.test(input);
};
