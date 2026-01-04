import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
export declare const createRoomHandler: (req: Request, res: Response) => Promise<void>;
export declare const getRoomHandler: (req: Request, res: Response) => Promise<void>;
export declare const generateUploadUrlHandler: (req: AuthRequest, res: Response) => Promise<void>;
export declare const generatePairingCodeHandler: (req: Request, res: Response) => Promise<void>;
export declare const validatePairingCodeHandler: (req: Request, res: Response) => Promise<void>;
/**
 * Handle local file upload (fallback when GCS is not configured)
 */
export declare const uploadLocalFileHandler: (req: AuthRequest, res: Response) => Promise<void>;
export declare const endRoomHandler: (req: AuthRequest, res: Response) => Promise<void>;
export declare const leaveRoomHandler: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=roomController.d.ts.map