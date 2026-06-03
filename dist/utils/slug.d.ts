/** Room URL slug prefix (matches marketing routes like /linkchat-create-room) */
export declare const LINKCHAT_SLUG_PREFIX = "linkchat";
/**
 * Generate a URL-safe slug from a string
 */
export declare const generateSlug: (text: string) => string;
/**
 * Generate a unique room slug: linkchat-{name}-{code} or linkchat-{code}
 */
export declare const generateUniqueSlug: (baseSlug: string, code: string) => string;
/**
 * Extract room code from a slug (e.g., "linkchat-team-sync-8321" -> "8321")
 */
export declare const extractCodeFromSlug: (slug: string) => string | null;
/**
 * Check if a string is a numeric room code
 */
export declare const isNumericCode: (input: string) => boolean;
//# sourceMappingURL=slug.d.ts.map