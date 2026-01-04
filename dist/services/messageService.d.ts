import { Message } from '../types/index.js';
export declare const createMessage: (roomCode: string, userId: string, nickname: string, content: string, type?: "text" | "file", fileMeta?: Message["fileMeta"], replyTo?: string, avatar?: string) => Promise<Message>;
export declare const getRoomMessages: (roomCode: string, limit?: number) => Promise<Message[]>;
export declare const deleteMessage: (messageId: string, userId: string) => Promise<boolean>;
export declare const addReaction: (messageId: string, userId: string, emoji: string) => Promise<Message | null>;
export declare const removeReaction: (messageId: string, userId: string, emoji: string) => Promise<Message | null>;
export declare const editMessage: (messageId: string, userId: string, content: string) => Promise<Message | null>;
export declare const pinMessage: (messageId: string, roomCode: string) => Promise<Message | null>;
export declare const unpinMessage: (messageId: string, roomCode: string) => Promise<Message | null>;
export declare const searchMessages: (roomCode: string, query: string, limit?: number) => Promise<Message[]>;
export declare const getPinnedMessages: (roomCode: string) => Promise<Message[]>;
//# sourceMappingURL=messageService.d.ts.map