import mongoose, { Schema } from 'mongoose';

export type PaymentStatus = 'pending' | 'confirmed' | 'refunded';
export type PaymentMethod = 'admin_manual' | 'bank_transfer' | 'upi' | 'free_grant' | 'other';

/** An admin-recorded payment (no live payment gateway is integrated — see PaymentRecord docs).
 *  Doubles as the receipt/invoice record referenced in the payment-confirmation email. */
export interface IPaymentRecord {
  userId: mongoose.Types.ObjectId;
  planId: mongoose.Types.ObjectId;
  subscriptionId: mongoose.Types.ObjectId;
  amount: number; // smallest currency unit
  currency: string;
  status: PaymentStatus;
  method: PaymentMethod;
  receiptNumber: string;
  note?: string;
  recordedBy?: mongoose.Types.ObjectId;
  confirmedBy?: mongoose.Types.ObjectId;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentRecordSchema = new Schema<IPaymentRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'UserSubscription', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['pending', 'confirmed', 'refunded'], default: 'pending', index: true },
    method: { type: String, enum: ['admin_manual', 'bank_transfer', 'upi', 'free_grant', 'other'], required: true },
    receiptNumber: { type: String, required: true, unique: true },
    note: { type: String, maxlength: 500 },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: { type: Date },
  },
  { timestamps: true }
);

PaymentRecordSchema.index({ userId: 1, createdAt: -1 });

export const PaymentRecordModel = mongoose.model<IPaymentRecord>(
  'PaymentRecord',
  PaymentRecordSchema
);

/** LC-{YYYYMMDD}-{6 random alphanumeric} — human-readable, practically-unique receipt number. */
export function generateReceiptNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LC-${date}-${random}`;
}
