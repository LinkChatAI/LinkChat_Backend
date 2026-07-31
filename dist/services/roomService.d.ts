import { Room, CreateRoomRequest } from '../types/index.js';
/**
 * Exported because the room purge path must evict this synchronously. A cached
 * entry outliving its room isn't just stale-read latency: room codes are
 * recycled from a small patterned space, so a purge that leaves the entry
 * behind can serve the previous tenant's room object (ownerId, plan, lock
 * state) to the next room issued that code.
 */
export declare const invalidateRoomCache: (code: string) => void;
export declare const createRoom: (data?: CreateRoomRequest) => Promise<Room>;
export declare const getRoomByCode: (code: string) => Promise<Room | null>;
export declare const getRoomBySlug: (slug: string) => Promise<Room | null>;
export declare const getRoomBySlugOrCode: (slugOrCode: string) => Promise<Room | null>;
export declare const getPublicRooms: (limit?: number) => Promise<Room[]>;
export declare const verifyRoomToken: (token: string, code: string) => boolean;
export declare const endRoom: (code: string, userId: string) => Promise<Room>;
export declare const removeParticipant: (code: string, userId: string) => Promise<Room>;
export declare const unlockRoom: (code: string) => Promise<Room>;
export declare const transferRoomOwnership: (code: string, newOwnerId: string) => Promise<Room>;
export declare const addRoomCoHost: (code: string, userId: string) => Promise<Room>;
export declare const removeRoomCoHost: (code: string, userId: string) => Promise<Room>;
export declare const setRoomSlowMode: (code: string, messagesPerMinute: number) => Promise<Room>;
export declare const setParticipantsCanSend: (code: string, canSend: boolean) => Promise<Room>;
export declare const setJoinLocked: (code: string, locked: boolean) => Promise<Room>;
export declare const lockRoom: (code: string) => Promise<Room>;
//# sourceMappingURL=roomService.d.ts.map