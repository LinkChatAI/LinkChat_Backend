import mongoose, { Schema } from 'mongoose';

/**
 * A Razorpay-backed donation. Unlike PaymentRecord (admin-recorded, no gateway),
 * every Donation row maps 1:1 to a Razorpay order and moves through its
 * lifecycle via signature-verified checkout callbacks and webhooks.
 *
 * Status transitions (enforced with guarded findOneAndUpdate filters so
 * webhook + verify-callback racing stays idempotent):
 *   created -> paid | failed
 *   paid    -> refunded | partially_refunded
 */
export type DonationStatus =
  | 'created'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partially_refunded';

export interface IDonationRefund {
  razorpayRefundId: string;
  amount: number; // paise
  status: string; // razorpay refund status: pending | processed | failed
  reason?: string;
  initiatedBy?: string; // admin id (hash) that triggered it
  createdAt: Date;
}

export interface IDonation {
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  amount: number; // paise (smallest currency unit)
  amountRefunded: number; // paise
  currency: string;
  status: DonationStatus;
  /** Actual instrument Razorpay reports (upi, card, netbanking, wallet). */
  paymentMethod?: string;
  /** UPI VPA / card network+last4 / bank code — display-only detail. */
  paymentMethodDetail?: string;
  receiptNumber: string;
  donorName?: string;
  donorEmail?: string;
  donorMessage?: string;
  /** True once the checkout-callback HMAC signature was verified server-side. */
  signatureVerified: boolean;
  /** True once at least one webhook event with a valid signature touched this donation. */
  webhookVerified: boolean;
  failureReason?: string;
  adminNote?: string;
  receiptEmailSentAt?: Date;
  refunds: IDonationRefund[];
  ipAddress?: string;
  userAgent?: string;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DonationRefundSchema = new Schema<IDonationRefund>(
  {
    razorpayRefundId: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, required: true },
    reason: { type: String, maxlength: 300 },
    initiatedBy: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const DonationSchema = new Schema<IDonation>(
  {
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, index: true, sparse: true },
    amount: { type: Number, required: true, min: 100 }, // Razorpay minimum: ₹1
    amountRefunded: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: ['created', 'paid', 'failed', 'refunded', 'partially_refunded'],
      default: 'created',
      index: true,
    },
    paymentMethod: { type: String },
    paymentMethodDetail: { type: String, maxlength: 200 },
    receiptNumber: { type: String, required: true, unique: true },
    donorName: { type: String, maxlength: 100 },
    donorEmail: { type: String, maxlength: 254 },
    donorMessage: { type: String, maxlength: 500 },
    signatureVerified: { type: Boolean, default: false },
    webhookVerified: { type: Boolean, default: false },
    failureReason: { type: String, maxlength: 500 },
    adminNote: { type: String, maxlength: 1000 },
    receiptEmailSentAt: { type: Date },
    refunds: { type: [DonationRefundSchema], default: [] },
    ipAddress: { type: String },
    userAgent: { type: String, maxlength: 300 },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

DonationSchema.index({ status: 1, createdAt: -1 });
DonationSchema.index({ createdAt: -1 });
DonationSchema.index({ donorEmail: 1 }, { sparse: true });

export const DonationModel = mongoose.model<IDonation>('Donation', DonationSchema);

/** LCD-{YYYYMMDD}-{6 random alphanumeric} — donation receipt number (LCD = LinkChat Donation). */
export function generateDonationReceiptNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LCD-${date}-${random}`;
}
