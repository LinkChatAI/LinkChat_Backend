export interface Room {
  code: string;
  token: string;
  ownerId?: string; // userId of the room creator (for RBAC)
  name?: string;
  slug?: string;
  isPublic?: boolean;
  createdAt: Date;
  expiresAt: Date;
  participants: string[];
  isEnded?: boolean;
  endedAt?: Date;
  endedBy?: string;
  isLocked?: boolean; // Room is locked (admin left, 24h countdown)
  lockedAt?: Date; // When the room was locked
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
  reactions?: { [emoji: string]: string[] }; // emoji -> userIds array
  replyTo?: string; // messageId of replied message
  editedAt?: Date;
  isPinned?: boolean;
  createdAt: Date;
  expiresAt?: Date; // TTL for auto-deletion (synced with room expiry)
  deletedByAdmin?: boolean; // Flag indicating message was deleted by admin
}

export interface CreateRoomRequest {
  nickname?: string;
  name?: string;
  isPublic?: boolean;
  userId?: string; // UUID of the room creator (for RBAC)
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

