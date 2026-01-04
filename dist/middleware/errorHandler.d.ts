import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
export interface ApiError extends Error {
    statusCode?: number;
    code?: string;
}
export declare const errorHandler: (err: Error | ApiError | ZodError, req: Request, res: Response, next: NextFunction) => void;
export declare const createError: (message: string, statusCode?: number) => ApiError;
//# sourceMappingURL=errorHandler.d.ts.map