import { Room, CreateRoomRequest } from '../types/index.js';
export declare const createRoom: (data?: CreateRoomRequest) => Promise<Room>;
export declare const getRoomByCode: (code: string) => Promise<Room | null>;
export declare const getRoomBySlug: (slug: string) => Promise<Room | null>;
export declare const getRoomBySlugOrCode: (slugOrCode: string) => Promise<Room | null>;
export declare const getPublicRooms: (limit?: number) => Promise<Room[]>;
export declare const verifyRoomToken: (token: string, code: string) => boolean;
export declare const endRoom: (code: string, userId: string) => Promise<Room>;
export declare const removeParticipant: (code: string, userId: string) => Promise<Room>;
//# sourceMappingURL=roomService.d.ts.map