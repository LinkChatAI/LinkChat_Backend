export type RoomPlan = 'free' | 'premium' | 'pro' | 'enterprise';
export type UserPlan = RoomPlan;

export interface Room {
  code: string;
  token: string;
  ownerId?: string; // Anonymous guest UUID of the room creator (for RBAC)
  ownerUserId?: string; // Authenticated user MongoDB ID (for premium features)
  name?: string;
  slug?: string;
  isPublic?: boolean;
  plan?: RoomPlan; // Subscription plan — controls feature access (e.g. video uploads)
  createdAt: Date;
  expiresAt: Date;
  participants: string[];
  isEnded?: boolean;
  endedAt?: Date;
  endedBy?: string;
  isLocked?: boolean; // Room is locked (admin left, 24h countdown)
  lockedAt?: Date; // When the room was locked
  coHostIds?: string[];
  slowModeMessagesPerMinute?: number;
  participantsCanSend?: boolean; // false = only host/co-hosts can send
  joinLocked?: boolean; // true = no new participants can join
  storageUsed?: number; // Total storage used in bytes
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
  reactions?: { [emoji: string]: string[] }; // emoji -> userIds array
  replyTo?: string; // messageId of replied message
  editedAt?: Date;
  isPinned?: boolean;
  createdAt: Date;
  expiresAt?: Date; // TTL for auto-deletion (synced with room expiry)
  deletedByAdmin?: boolean; // Flag indicating message was deleted by admin
  seenBy?: string[]; // Per-user read receipts — array of userIds who have seen this message
  // Client-side ID for message reconciliation (echoed back from client)
  tempId?: string; // Temporary ID sent from client, echoed back by server
}

export interface CreateRoomRequest {
  nickname?: string;
  name?: string;
  isPublic?: boolean;
  userId?: string; // UUID of the room creator (for RBAC)
  ownerUserId?: string; // Authenticated user ID (premium sync)
  plan?: RoomPlan; // Subscription plan for the room
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

