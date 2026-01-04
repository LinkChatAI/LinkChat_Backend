import { MessageModel } from '../models/Message.js';
import { RoomModel } from '../models/Room.js';
import { v4 as uuidv4 } from 'uuid';
export const createMessage = async (roomCode, userId, nickname, content, type = 'text', fileMeta, replyTo, avatar) => {
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
export const getRoomMessages = async (roomCode, limit = 100) => {
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
export const deleteMessage = async (messageId, userId) => {
    // Validate input
    if (!messageId || typeof messageId !== 'string' || !userId || typeof userId !== 'string') {
        return false;
    }
    const result = await MessageModel.deleteOne({ id: messageId.trim(), userId: userId.trim() });
    return result.deletedCount > 0;
};
export const addReaction = async (messageId, userId, emoji) => {
    const message = await MessageModel.findOne({ id: messageId });
    if (!message)
        return null;
    const reactions = message.reactions || {};
    const userIds = reactions[emoji] || [];
    if (!userIds.includes(userId)) {
        reactions[emoji] = [...userIds, userId];
        message.reactions = reactions;
        await message.save();
    }
    return message.toObject();
};
export const removeReaction = async (messageId, userId, emoji) => {
    const message = await MessageModel.findOne({ id: messageId });
    if (!message)
        return null;
    const reactions = message.reactions || {};
    const userIds = reactions[emoji] || [];
    const filtered = userIds.filter((id) => id !== userId);
    if (filtered.length === 0) {
        delete reactions[emoji];
    }
    else {
        reactions[emoji] = filtered;
    }
    message.reactions = reactions;
    await message.save();
    return message.toObject();
};
export const editMessage = async (messageId, userId, content) => {
    const message = await MessageModel.findOne({ id: messageId, userId });
    if (!message)
        return null;
    message.content = content;
    message.editedAt = new Date();
    await message.save();
    return message.toObject();
};
export const pinMessage = async (messageId, roomCode) => {
    await MessageModel.updateMany({ roomCode, isPinned: true }, { isPinned: false });
    const message = await MessageModel.findOne({ id: messageId, roomCode });
    if (!message)
        return null;
    message.isPinned = true;
    await message.save();
    return message.toObject();
};
export const unpinMessage = async (messageId, roomCode) => {
    const message = await MessageModel.findOne({ id: messageId, roomCode });
    if (!message)
        return null;
    message.isPinned = false;
    await message.save();
    return message.toObject();
};
export const searchMessages = async (roomCode, query, limit = 50) => {
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
export const getPinnedMessages = async (roomCode) => {
    const messages = await MessageModel.find({ roomCode, isPinned: true })
        .sort({ createdAt: -1 })
        .lean()
        .exec();
    return messages.reverse();
};
//# sourceMappingURL=messageService.js.map