import mongoose, { Schema } from 'mongoose';
import { Room as IRoom } from '../types';

const RoomSchema = new Schema<IRoom>(
  {
    code: { type: String, required: true, unique: true, index: true },
    token: { type: String, required: true },
    name: { type: String, index: true },
    slug: { type: String, unique: true, sparse: true, index: true },
    isPublic: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    participants: { type: [String], default: [] },
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

export const RoomModel = mongoose.model<IRoom>('Room', RoomSchema);

