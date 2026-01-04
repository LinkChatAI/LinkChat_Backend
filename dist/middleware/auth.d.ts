import { Request, Response, NextFunction } from 'express';
export interface AuthRequest extends Request {
    roomCode?: string;
}
export declare const authenticateRoom: (req: AuthRequest, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map