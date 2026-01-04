import mongoose, { Schema } from 'mongoose';
const MessageSchema = new Schema({
    id: { type: String, required: true, unique: true },
    roomCode: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    nickname: { type: String, required: true },
    avatar: { type: String },
    content: { type: String, required: true },
    type: { type: String, enum: ['text', 'file'], default: 'text' },
    fileMeta: {
        name: String,
        size: Number,
        url: String,
        mimeType: String,
    },
    reactions: { type: Schema.Types.Mixed, default: {} },
    replyTo: { type: String },
    editedAt: { type: Date },
    isPinned: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, required: false }, // TTL expiration
}, { timestamps: true });
// TTL index for automatic message expiration (synced with room expiry)
MessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Compound index for room message queries (most common)
MessageSchema.index({ roomCode: 1, createdAt: -1 });
// Index for message ID lookups
MessageSchema.index({ id: 1 }, { unique: true });
// Index for user message queries (for deletion)
MessageSchema.index({ id: 1, userId: 1 });
// Index for pinned messages
MessageSchema.index({ roomCode: 1, isPinned: 1 });
export const MessageModel = mongoose.model('Message', MessageSchema);
//# sourceMappingURL=Message.js.map