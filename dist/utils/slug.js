/** Room URL slug prefix (matches marketing routes like /linkchat-create-room) */
export const LINKCHAT_SLUG_PREFIX = 'linkchat';
/**
 * Generate a URL-safe slug from a string
 */
export const generateSlug = (text) => {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/[\s_-]+/g, '-') // Replace spaces/underscores with hyphens
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
};
/** Avoid double prefix when the room name already starts with "linkchat" */
const stripLinkchatPrefix = (slugPart) => {
    if (!slugPart)
        return '';
    if (slugPart === LINKCHAT_SLUG_PREFIX)
        return '';
    if (slugPart.startsWith(`${LINKCHAT_SLUG_PREFIX}-`)) {
        return slugPart.slice(LINKCHAT_SLUG_PREFIX.length + 1);
    }
    return slugPart;
};
/**
 * Generate a unique room slug: linkchat-{name}-{code} or linkchat-{code}
 */
export const generateUniqueSlug = (baseSlug, code) => {
    const cleanBase = stripLinkchatPrefix(generateSlug(baseSlug));
    if (!cleanBase) {
        return `${LINKCHAT_SLUG_PREFIX}-${code}`;
    }
    return `${LINKCHAT_SLUG_PREFIX}-${cleanBase}-${code}`;
};
/**
 * Extract room code from a slug (e.g., "linkchat-team-sync-8321" -> "8321")
 */
export const extractCodeFromSlug = (slug) => {
    const match = slug.match(/-(\d+)$/);
    return match ? match[1] : null;
};
/**
 * Check if a string is a numeric room code
 */
export const isNumericCode = (input) => {
    return /^\d+$/.test(input);
};
//# sourceMappingURL=slug.js.map