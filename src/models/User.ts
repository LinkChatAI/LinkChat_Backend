import mongoose, { Schema } from 'mongoose';
import { UserPlan } from '../types/index.js';

export interface SavedRoomEntry {
  roomCode: string;
  slug?: string;
  name?: string;
  savedAt: Date;
}

export interface IUser {
  googleId: string;
  email: string;
  name: string;
  avatar?: string;
  plan: UserPlan;
  linkedGuestId?: string;
  savedRooms: SavedRoomEntry[];
  refreshTokenHash?: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SavedRoomSchema = new Schema<SavedRoomEntry>(
  {
    roomCode: { type: String, required: true },
    slug: { type: String },
    name: { type: String },
    savedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const UserSchema = new Schema<IUser>(
  {
    googleId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    avatar: { type: String },
    plan: {
      type: String,
      enum: ['free', 'premium', 'pro', 'enterprise'] as UserPlan[],
      default: 'free',
      index: true,
    },
    linkedGuestId: { type: String, index: true, sparse: true },
    savedRooms: { type: [SavedRoomSchema], default: [] },
    refreshTokenHash: { type: String },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

UserSchema.index({ 'savedRooms.roomCode': 1 });

export const UserModel = mongoose.model<IUser>('User', UserSchema);
