export type RoomPlan = 'free' | 'premium' | 'pro' | 'enterprise';
export type UserPlan = RoomPlan;
export interface Room {
    code: string;
    token: string;
    ownerId?: string;
    ownerUserId?: string;
    name?: string;
    slug?: string;
    isPublic?: boolean;
    plan?: RoomPlan;
    createdAt: Date;
    expiresAt: Date;
    participants: string[];
    isEnded?: boolean;
    endedAt?: Date;
    endedBy?: string;
    isLocked?: boolean;
    lockedAt?: Date;
    coHostIds?: string[];
    slowModeMessagesPerMinute?: number;
    participantsCanSend?: boolean;
    joinLocked?: boolean;
    storageUsed?: number;
}
export interface Message {
    id: string;
    roomCode: string;
    userId: string;
    nickname: string;
    avatar?: string;
    content: string;
    type: 'text' | 'file' | 'image' | 'video';
    fileMeta?: {
        name: string;
        size: number;
        url: string;
        mimeType: string;
    };
    reactions?: {
        [emoji: string]: string[];
    };
    replyTo?: string;
    editedAt?: Date;
    isPinned?: boolean;
    createdAt: Date;
    expiresAt?: Date;
    deletedByAdmin?: boolean;
    seenBy?: string[];
    tempId?: string;
}
export interface CreateRoomRequest {
    nickname?: string;
    name?: string;
    isPublic?: boolean;
    userId?: string;
    ownerUserId?: string;
    plan?: RoomPlan;
}
export interface JoinRoomRequest {
    nickname?: string;
}
export interface SocketUser {
    userId: string;
    nickname: string;
    avatar?: string;
    roomCode: string;
    /**
     * Super Admin Ghost Mode — set only by resolveGhostModeFromSocket() after
     * verifying the platform session cookie server-side against the
     * GHOST_MODE_ADMIN_EMAILS allowlist. Never trust a client-supplied value
     * for this; there isn't one — clients cannot set or request this flag.
     */
    isGhost?: boolean;
}
//# sourceMappingURL=index.d.ts.map