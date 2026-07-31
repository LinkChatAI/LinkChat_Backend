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
 * DELETE /api/rooms/:code — permanently vanish a room.
 *
 * Authorization is mandatory. This endpoint previously had none: no auth
 * middleware and no ownership check, guarded only by a per-IP rate limit. With
 * patterned 4-digit codes the entire keyspace is 370 values, so anyone could
 * enumerate it and permanently destroy every live room on the platform.
 *
 * The `authenticateRoom` middleware on this route proves the caller holds a
 * valid room token. This handler additionally checks that the token was issued
 * for THIS room — the middleware only verifies the signature and does not
 * compare its roomCode claim against the :code param, so without this check a
 * token for any room the caller legitimately owns would authorize deleting
 * every other room.
 */
export declare const deleteRoomHandler: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getMessagesHandler: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=roomController.d.ts.map