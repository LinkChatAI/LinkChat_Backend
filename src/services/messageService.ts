import { MessageModel } from '../models/Message.js';
import { RoomModel } from '../models/Room.js';
import { Message } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export const createMessage = async (
  roomCode: string,
  userId: string,
  nickname: string,
  content: string,
  type: 'text' | 'file' = 'text',
  fileMeta?: Message['fileMeta'],
  replyTo?: string,
  avatar?: string
): Promise<Message> => {
  // Get room to set message expiry matching room expiry
  const room = await RoomModel.findOne({ code: roomCode }).select('expiresAt').lean();
  
  const message = new MessageModel({
    id: uuidv4(),
    roomCode,
    userId,
    nickname,
    avatar,
    content,
    type,
    fileMeta,
    replyTo,
    reactions: {},
    isPinned: false,
    createdAt: new Date(),
    expiresAt: room?.expiresAt, // TTL sync with room expiry
  });

  await message.save();
  return message.toObject();
};

export const getRoomMessages = async (roomCode: string, limit = 100): Promise<Message[]> => {
  // Validate input
  if (!roomCode || typeof roomCode !== 'string') {
    throw new Error('Invalid room code');
  }

  const maxLimit = Math.min(limit, 500); // Cap at 500 messages
  const messages = await MessageModel.find({ roomCode })
    .sort({ createdAt: -1 })
    .limit(maxLimit)
    .lean()
    .exec();
  return messages.reverse();
};

export const getMessagesAfterId = async (roomCode: string, lastMessageId?: string, limit = 100): Promise<Message[]> => {
  // Validate input
  if (!roomCode || typeof roomCode !== 'string') {
    throw new Error('Invalid room code');
  }

  const maxLimit = Math.min(limit, 500); // Cap at 500 messages
  
  let query: any = { roomCode };
  
  // If lastMessageId is provided, fetch messages created after that message
  if (lastMessageId && typeof lastMessageId === 'string' && lastMessageId.trim()) {
    // First, find the message with the given ID to get its createdAt timestamp
    const lastMessage = await MessageModel.findOne({ id: lastMessageId.trim(), roomCode }).lean();
    if (lastMessage) {
      query.createdAt = { $gt: lastMessage.createdAt };
    }
  }
  
  const messages = await MessageModel.find(query)
    .sort({ createdAt: 1 }) // Sort ascending to get messages in chronological order
    .limit(maxLimit)
    .lean()
    .exec();
  
  return messages;
};

export const deleteMessage = async (messageId: string, userId: string, roomOwnerId?: string): Promise<boolean> => {
  // Validate input
  if (!messageId || typeof messageId !== 'string' || !userId || typeof userId !== 'string') {
    return false;
  }

  // Fetch the message to check ownership
  const message = await MessageModel.findOne({ id: messageId.trim() });
  if (!message) return false;

  // Permission check: Allow deletion if:
  // 1. User is deleting their own message (message.userId === userId)
  // 2. OR user is the room owner (roomOwnerId === userId)
  const canDelete = message.userId === userId.trim() || (roomOwnerId && roomOwnerId.trim() === userId.trim());
  
  if (!canDelete) {
    return false;
  }

  const result = await MessageModel.deleteOne({ id: messageId.trim() });
  return result.deletedCount > 0;
};

export const addReaction = async (
  messageId: string,
  userId: string,
  emoji: string
): Promise<Message | null> => {
  const message = await MessageModel.findOne({ id: messageId });
  if (!message) return null;

  const reactions = (message.reactions as { [key: string]: string[] }) || {};
  const userIds = reactions[emoji] || [];
  
  if (!userIds.includes(userId)) {
    reactions[emoji] = [...userIds, userId];
    message.reactions = reactions;
    await message.save();
  }

  return message.toObject();
};

export const removeReaction = async (
  messageId: string,
  userId: string,
  emoji: string
): Promise<Message | null> => {
  const message = await MessageModel.findOne({ id: messageId });
  if (!message) return null;

  const reactions = (message.reactions as { [key: string]: string[] }) || {};
  const userIds = reactions[emoji] || [];
  const filtered = userIds.filter((id: string) => id !== userId);
  
  if (filtered.length === 0) {
    delete reactions[emoji];
  } else {
    reactions[emoji] = filtered;
  }
  
  message.reactions = reactions;
  await message.save();
  
  return message.toObject();
};

export const editMessage = async (messageId: string, userId: string, content: string): Promise<Message | null> => {
  const message = await MessageModel.findOne({ id: messageId, userId });
  if (!message) return null;
  
  message.content = content;
  message.editedAt = new Date();
  await message.save();
  
  return message.toObject();
};

export const pinMessage = async (messageId: string, roomCode: string): Promise<Message | null> => {
  await MessageModel.updateMany({ roomCode, isPinned: true }, { isPinned: false });
  const message = await MessageModel.findOne({ id: messageId, roomCode });
  if (!message) return null;
  message.isPinned = true;
  await message.save();
  return message.toObject();
};

export const unpinMessage = async (messageId: string, roomCode: string): Promise<Message | null> => {
  const message = await MessageModel.findOne({ id: messageId, roomCode });
  if (!message) return null;
  message.isPinned = false;
  await message.save();
  return message.toObject();
};

export const searchMessages = async (roomCode: string, query: string, limit = 50): Promise<Message[]> => {
  const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const messages = await MessageModel.find({
    roomCode,
    content: searchRegex,
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .lean()
    .exec();
  return messages.reverse();
};

export const getPinnedMessages = async (roomCode: string): Promise<Message[]> => {
  const messages = await MessageModel.find({ roomCode, isPinned: true })
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  return messages.reverse();
};

