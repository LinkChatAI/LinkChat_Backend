import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { UserAuthRequest } from '../middleware/userAuth.js';
export declare const createRoomHandler: (req: UserAuthRequest, res: Response) => Promise<void>;
export declare const getRoomHandler: (req: Request, res: Response) => Promise<void>;
export declare const generateUploadUrlHandler: (req: AuthRequest, res: Response) => Promise<void>;
export declare const generateUploadUrlPublicHandler: (req: Request, res: Response) => Promise<void>;
export declare const generatePairingCodeHandler: (req: Request, res: Response) => Promise<void>;
export declare const validatePairingCodeHandler: (req: Request, res: Response) => Promise<void>;
export declare const endRoomHandler: (req: AuthRequest, res: Response) => Promise<void>;
export declare const leaveRoomHandler: (req: Request, res: Response) => Promise<void>;
/**
 * Secure deleteRoom (Vanish) function that strictly ensures NO data is left behind.
 * Implements Cleanup Cascade:
 * 1. Wipe Google Cloud Storage files (rooms/{roomCode}/*)
 * 2. Wipe Database (Messages, then Room)
 * 3. Notify Users via Socket.IO (room_vanished event)
 */
export declare const deleteRoomHandler: (req: Request, res: Response) => Promise<void>;
export declare const getMessagesHandler: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=roomController.d.ts.map