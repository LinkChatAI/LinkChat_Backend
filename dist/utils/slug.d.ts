/**
 * Generate a URL-safe slug from a string
 */
export declare const generateSlug: (text: string) => string;
/**
 * Generate a unique slug by appending a random suffix
 */
export declare const generateUniqueSlug: (baseSlug: string, code: string) => string;
/**
 * Extract room code from a slug (e.g., "team-sync-8321" -> "8321")
 */
export declare const extractCodeFromSlug: (slug: string) => string | null;
/**
 * Check if a string is a numeric room code
 */
export declare const isNumericCode: (input: string) => boolean;
//# sourceMappingURL=slug.d.ts.map