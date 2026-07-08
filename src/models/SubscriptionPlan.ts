import mongoose, { Schema } from 'mongoose';
import { UserPlan } from '../types/index.js';

export type BillingPeriod = 'monthly' | 'yearly' | 'one_time';

/** An admin-managed pricing package. `tier` maps onto the existing User/Room plan enum so
 *  purchasing a plan flows straight into the feature-gating already used across the app. */
export interface ISubscriptionPlan {
  name: string;
  slug: string;
  description?: string;
  tier: UserPlan;
  price: number; // smallest currency unit (e.g. paise for INR)
  currency: string;
  billingPeriod: BillingPeriod;
  creditsIncluded: number;
  features: string[];
  isActive: boolean;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionPlanSchema = new Schema<ISubscriptionPlan>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 1000 },
    tier: {
      type: String,
      enum: ['free', 'premium', 'pro', 'enterprise'] as UserPlan[],
      required: true,
      index: true,
    },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', maxlength: 10 },
    billingPeriod: { type: String, enum: ['monthly', 'yearly', 'one_time'], required: true },
    creditsIncluded: { type: Number, default: 0, min: 0 },
    features: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

SubscriptionPlanSchema.index({ isActive: 1, price: 1 });

export const SubscriptionPlanModel = mongoose.model<ISubscriptionPlan>(
  'SubscriptionPlan',
  SubscriptionPlanSchema
);
