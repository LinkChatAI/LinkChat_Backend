import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { logger } from './logger.js';
export const generateToken = (roomCode) => {
    if (!env.JWT_SECRET || env.JWT_SECRET === 'default-secret-change-in-production') {
        logger.warn('JWT_SECRET is using default value. This should be changed in production.');
    }
    try {
        return jwt.sign({ roomCode }, env.JWT_SECRET, { expiresIn: '7d' });
    }
    catch (error) {
        logger.error('Error generating JWT token', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw new Error('Failed to generate authentication token');
    }
};
export const verifyToken = (token) => {
    try {
        const decoded = jwt.verify(token, env.JWT_SECRET);
        if (typeof decoded === 'object' && decoded !== null && 'roomCode' in decoded) {
            return decoded;
        }
        return null;
    }
    catch (error) {
        logger.debug('Token verification failed', { error: error instanceof Error ? error.message : 'Unknown error' });
        return null;
    }
};
//# sourceMappingURL=jwt.js.map