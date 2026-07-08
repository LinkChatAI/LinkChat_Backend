import mongoose, { Schema } from 'mongoose';
import { UserPlan } from '../types/index.js';

export interface SavedRoomEntry {
  roomCode: string;
  slug?: string;
  name?: string;
  savedAt: Date;
}

export type UserRole = 'user' | 'admin';
export type UserAccountStatus = 'active' | 'suspended' | 'banned';

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

  /** RBAC role. 'admin' can access the billing/user-management admin panel. */
  role: UserRole;
  /** Account standing — suspended/banned users are blocked from logging in and using paid features. */
  status: UserAccountStatus;
  isVerified: boolean;
  /** Spendable credit balance — see CreditTransaction for the ledger. */
  credits: number;

  statusReason?: string;
  statusChangedAt?: Date;
  statusChangedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  verifiedBy?: mongoose.Types.ObjectId;

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

    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    status: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active', index: true },
    isVerified: { type: Boolean, default: false },
    credits: { type: Number, default: 0, min: 0 },

    statusReason: { type: String, maxlength: 500 },
    statusChangedAt: { type: Date },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

UserSchema.index({ 'savedRooms.roomCode': 1 });
UserSchema.index({ status: 1, createdAt: -1 });

export const UserModel = mongoose.model<IUser>('User', UserSchema);
