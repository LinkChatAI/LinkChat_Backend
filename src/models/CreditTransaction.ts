import mongoose, { Schema } from 'mongoose';

export type CreditTransactionType = 'admin_grant' | 'purchase' | 'usage' | 'refund' | 'expiry';

/** Append-only ledger — a user's `credits` balance on the User doc is always derived from
 *  (and must stay consistent with) the sum of these entries; each entry records the running total. */
export interface ICreditTransaction {
  userId: mongoose.Types.ObjectId;
  amount: number; // positive = credit, negative = debit
  balanceAfter: number;
  type: CreditTransactionType;
  reason?: string;
  grantedBy?: mongoose.Types.ObjectId;
  relatedSubscriptionId?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const CreditTransactionSchema = new Schema<ICreditTransaction>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    type: { type: String, enum: ['admin_grant', 'purchase', 'usage', 'refund', 'expiry'], required: true },
    reason: { type: String, maxlength: 500 },
    grantedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    relatedSubscriptionId: { type: Schema.Types.ObjectId, ref: 'UserSubscription' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CreditTransactionSchema.index({ userId: 1, createdAt: -1 });

export const CreditTransactionModel = mongoose.model<ICreditTransaction>(
  'CreditTransaction',
  CreditTransactionSchema
);
