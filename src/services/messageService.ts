import { MessageModel } from '../models/Message';
import { Message } from '../types';
import { v4 as uuidv4 } from 'uuid';

export const createMessage = async (
  roomCode: string,
  userId: string,
  nickname: string,
  content: string,
  type: 'text' | 'file' = 'text',
  fileMeta?: Message['fileMeta']
): Promise<Message> => {
  const message = new MessageModel({
    id: uuidv4(),
    roomCode,
    userId,
    nickname,
    content,
    type,
    fileMeta,
    reactions: {},
    createdAt: new Date(),
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

export const deleteMessage = async (messageId: string, userId: string): Promise<boolean> => {
  // Validate input
  if (!messageId || typeof messageId !== 'string' || !userId || typeof userId !== 'string') {
    return false;
  }

  const result = await MessageModel.deleteOne({ id: messageId.trim(), userId: userId.trim() });
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

