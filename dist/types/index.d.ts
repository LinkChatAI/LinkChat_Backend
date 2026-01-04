export interface Room {
    code: string;
    token: string;
    name?: string;
    slug?: string;
    isPublic?: boolean;
    createdAt: Date;
    expiresAt: Date;
    participants: string[];
    isEnded?: boolean;
    endedAt?: Date;
    endedBy?: string;
}
export interface Message {
    id: string;
    roomCode: string;
    userId: string;
    nickname: string;
    avatar?: string;
    content: string;
    type: 'text' | 'file';
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
}
export interface CreateRoomRequest {
    nickname?: string;
    name?: string;
    isPublic?: boolean;
}
export interface JoinRoomRequest {
    nickname?: string;
}
export interface SocketUser {
    userId: string;
    nickname: string;
    avatar?: string;
    roomCode: string;
}
//# sourceMappingURL=index.d.ts.map