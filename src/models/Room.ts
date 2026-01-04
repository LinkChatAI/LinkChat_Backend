import mongoose, { Schema } from 'mongoose';
import { Room as IRoom } from '../types/index.js';

const RoomSchema = new Schema<IRoom>(
  {
    code: { type: String, required: true, unique: true, index: true },
    token: { type: String, required: true },
    ownerId: { type: String, index: true }, // userId of the room creator (for RBAC)
    name: { type: String, index: true },
    slug: { type: String, unique: true, sparse: true, index: true },
    isPublic: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    participants: { type: [String], default: [] },
    isEnded: { type: Boolean, default: false },
    endedAt: { type: Date },
    endedBy: { type: String },
    isLocked: { type: Boolean, default: false, index: true }, // Room is locked (admin left, 24h countdown)
    lockedAt: { type: Date, index: true }, // When the room was locked
  },
  { timestamps: true }
);

// TTL index for automatic expiration
RoomSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Compound index for public room queries
RoomSchema.index({ slug: 1, isPublic: 1 });
// Index for code lookups (most common query)
RoomSchema.index({ code: 1 }, { unique: true });
// Index for expiration checks
RoomSchema.index({ expiresAt: 1, isPublic: 1 });
// Compound index for auto-vanish queries (locked rooms ready to vanish)
RoomSchema.index({ isLocked: 1, lockedAt: 1, isEnded: 1 });
// Index for auto-vanish worker queries (optimized for frequent checks)
RoomSchema.index({ isLocked: 1, lockedAt: 1, isEnded: 1, expiresAt: 1 });

export const RoomModel = mongoose.model<IRoom>('Room', RoomSchema);

