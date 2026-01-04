import { Request, Response, NextFunction } from 'express';
export declare const rateLimiter: (type?: string) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
export declare const socketRateLimiter: (socketId: string, eventType: string, maxRequests?: number, windowMs?: number) => Promise<boolean>;
//# sourceMappingURL=rateLimiter.d.ts.map