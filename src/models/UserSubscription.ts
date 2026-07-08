import mongoose, { Schema } from 'mongoose';
import { UserPlan } from '../types/index.js';
import { BillingPeriod } from './SubscriptionPlan.js';

export type SubscriptionStatus = 'pending' | 'active' | 'expired' | 'cancelled';
export type SubscriptionSource = 'admin_grant' | 'admin_recorded_payment' | 'purchase_request';

/** A snapshot of the plan's terms at grant time, so later plan edits never rewrite history. */
export interface PlanSnapshot {
  name: string;
  tier: UserPlan;
  price: number;
  currency: string;
  billingPeriod: BillingPeriod;
  creditsIncluded: number;
}

export interface IUserSubscription {
  userId: mongoose.Types.ObjectId;
  planId: mongoose.Types.ObjectId;
  planSnapshot: PlanSnapshot;
  status: SubscriptionStatus;
  source: SubscriptionSource;
  startedAt?: Date;
  expiresAt?: Date; // undefined = lifetime (one_time billing period)
  grantedBy?: mongoose.Types.ObjectId; // admin who granted/confirmed it
  reason?: string;
  cancelledAt?: Date;
  cancelledBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PlanSnapshotSchema = new Schema<PlanSnapshot>(
  {
    name: { type: String, required: true },
    tier: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    billingPeriod: { type: String, required: true },
    creditsIncluded: { type: Number, default: 0 },
  },
  { _id: false }
);

const UserSubscriptionSchema = new Schema<IUserSubscription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true, index: true },
    planSnapshot: { type: PlanSnapshotSchema, required: true },
    status: { type: String, enum: ['pending', 'active', 'expired', 'cancelled'], default: 'pending', index: true },
    source: { type: String, enum: ['admin_grant', 'admin_recorded_payment', 'purchase_request'], required: true },
    startedAt: { type: Date },
    expiresAt: { type: Date, index: true },
    grantedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, maxlength: 500 },
    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

UserSubscriptionSchema.index({ userId: 1, status: 1, createdAt: -1 });
UserSubscriptionSchema.index({ userId: 1, planId: 1, status: 1 });

export const UserSubscriptionModel = mongoose.model<IUserSubscription>(
  'UserSubscription',
  UserSubscriptionSchema
);
