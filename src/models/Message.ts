import mongoose, { Schema } from 'mongoose';
import { Message as IMessage } from '../types';

const MessageSchema = new Schema<IMessage>(
  {
    id: { type: String, required: true, unique: true },
    roomCode: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    nickname: { type: String, required: true },
    content: { type: String, required: true },
    type: { type: String, enum: ['text', 'file'], default: 'text' },
    fileMeta: {
      name: String,
      size: Number,
      url: String,
      mimeType: String,
    },
    reactions: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Compound index for room message queries (most common)
MessageSchema.index({ roomCode: 1, createdAt: -1 });
// Index for message ID lookups
MessageSchema.index({ id: 1 }, { unique: true });
// Index for user message queries (for deletion)
MessageSchema.index({ id: 1, userId: 1 });

export const MessageModel = mongoose.model<IMessage>('Message', MessageSchema);

