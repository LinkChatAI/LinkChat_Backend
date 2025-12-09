export interface Room {
  code: string;
  token: string;
  name?: string;
  slug?: string;
  isPublic?: boolean;
  createdAt: Date;
  expiresAt: Date;
  participants: string[];
}

export interface Message {
  id: string;
  roomCode: string;
  userId: string;
  nickname: string;
  content: string;
  type: 'text' | 'file';
  fileMeta?: {
    name: string;
    size: number;
    url: string;
    mimeType: string;
  };
  reactions?: { [emoji: string]: string[] }; // emoji -> userIds array
  createdAt: Date;
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
  roomCode: string;
}

