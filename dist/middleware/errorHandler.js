import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';
export const errorHandler = (err, req, res, next) => {
    // Zod validation errors
    if (err instanceof ZodError) {
        logger.warn('Validation error', {
            path: req.path,
            method: req.method,
            errors: err.errors,
        });
        res.status(400).json({
            error: 'Validation failed',
            details: err.errors.map((e) => ({
                path: e.path.join('.'),
                message: e.message,
            })),
        });
        return;
    }
    // Handle database connection errors
    if (err instanceof Error && err.message === 'Database connection not available') {
        logger.error('Database connection error in request', {
            path: req.path,
            method: req.method,
        });
        res.status(503).json({
            error: 'Service temporarily unavailable. Please try again later.',
        });
        return;
    }
    // Custom API errors
    const apiError = err;
    const statusCode = apiError.statusCode || 500;
    const message = apiError.message || 'Internal server error';
    if (statusCode >= 500) {
        logger.error('Server error', {
            path: req.path,
            method: req.method,
            error: message,
            stack: err.stack,
        });
    }
    else {
        logger.warn('Client error', {
            path: req.path,
            method: req.method,
            statusCode,
            error: message,
        });
    }
    res.status(statusCode).json({
        error: message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
};
export const createError = (message, statusCode = 500) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};
//# sourceMappingURL=errorHandler.js.map