/**
 * Sanitize user input to prevent XSS attacks
 */
export const sanitizeHtml = (input: string): string => {
  if (typeof input !== 'string') {
    return '';
  }

  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
};

/**
 * Sanitize text content (preserves newlines and basic formatting)
 */
export const sanitizeText = (input: string): string => {
  if (typeof input !== 'string') {
    return '';
  }

  // Remove null bytes and control characters except newlines and tabs
  return input
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
};

/**
 * Sanitize room name or nickname
 */
export const sanitizeName = (input: string): string => {
  if (typeof input !== 'string') {
    return '';
  }

  return sanitizeText(input)
    .substring(0, 100) // Limit length
    .replace(/[<>]/g, ''); // Remove angle brackets
};
