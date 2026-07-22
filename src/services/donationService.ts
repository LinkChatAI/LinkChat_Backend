import {
  DonationSettingsModel,
  DONATION_SETTINGS_DEFAULTS,
  IDonationSettings,
} from '../models/DonationSettings.js';
import { DonationModel, IDonation } from '../models/Donation.js';
import { RazorpayPayment } from './razorpayService.js';
import { sendEmail, escapeHtml } from './emailTransport.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Settings (singleton doc, short-TTL in-process cache — same rationale as
// adminSettingsService: the public config endpoint is hot, the doc is tiny)
// ---------------------------------------------------------------------------

const SETTINGS_CACHE_TTL_MS = 30 * 1000;
let cachedSettings: IDonationSettings | null = null;
let cachedAt = 0;

export async function getDonationSettings(): Promise<IDonationSettings> {
  const now = Date.now();
  if (cachedSettings && now - cachedAt < SETTINGS_CACHE_TTL_MS) {
    return cachedSettings;
  }

  try {
    let doc = await DonationSettingsModel.findById('global');
    if (!doc) {
      doc = await DonationSettingsModel.findOneAndUpdate(
        { _id: 'global' },
        { $setOnInsert: { _id: 'global', ...DONATION_SETTINGS_DEFAULTS } },
        { upsert: true, new: true }
      );
    }
    cachedSettings = doc!.toObject();
    cachedAt = now;
    return cachedSettings!;
  } catch (error: any) {
    logger.error('Failed to load donation settings, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Serve stale cache if we have one, otherwise env-independent defaults.
    if (cachedSettings) return cachedSettings;
    return {
      _id: 'global',
      ...DONATION_SETTINGS_DEFAULTS,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IDonationSettings;
  }
}

export async function updateDonationSettings(
  patch: Partial<IDonationSettings>,
  updatedBy?: string
): Promise<IDonationSettings> {
  const doc = await DonationSettingsModel.findOneAndUpdate(
    { _id: 'global' },
    { $set: { ...patch, updatedBy } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
  cachedSettings = doc!.toObject();
  cachedAt = Date.now();
  return cachedSettings!;
}

/** Invalidate after out-of-band writes (tests, scripts). */
export function invalidateDonationSettingsCache(): void {
  cachedSettings = null;
  cachedAt = 0;
}

// ---------------------------------------------------------------------------
// Idempotent state transitions
//
// Both the browser verify-callback and the webhook can report the same payment
// (in either order). Every transition below uses a guarded findOneAndUpdate so
// the first writer wins and replays are harmless no-ops.
// ---------------------------------------------------------------------------

function describeMethodDetail(payment: RazorpayPayment): string | undefined {
  switch (payment.method) {
    case 'upi':
      return payment.vpa || 'UPI';
    case 'card':
      return payment.card ? `${payment.card.network || 'card'} •${payment.card.last4 || '????'}` : 'card';
    case 'netbanking':
      return payment.bank || 'netbanking';
    case 'wallet':
      return payment.wallet || 'wallet';
    default:
      return payment.method;
  }
}

/**
 * Mark a donation paid from a verified source (signature-checked callback or
 * webhook). Returns the updated donation, or the existing one if it was
 * already paid (replay), or null if no donation matches the order.
 */
export async function markDonationPaid(params: {
  razorpayOrderId: string;
  payment: RazorpayPayment;
  source: 'callback' | 'webhook';
}): Promise<IDonation | null> {
  const { razorpayOrderId, payment, source } = params;

  const verifiedFlag = source === 'callback' ? { signatureVerified: true } : { webhookVerified: true };

  const updated = await DonationModel.findOneAndUpdate(
    { razorpayOrderId, status: 'created' },
    {
      $set: {
        status: 'paid',
        razorpayPaymentId: payment.id,
        paymentMethod: payment.method,
        paymentMethodDetail: describeMethodDetail(payment),
        paidAt: new Date(),
        ...verifiedFlag,
      },
    },
    { new: true }
  );

  if (updated) {
    logger.info('Donation marked paid', {
      razorpayOrderId,
      razorpayPaymentId: payment.id,
      amount: updated.amount,
      method: payment.method,
      source,
    });
    return updated;
  }

  // Already transitioned (replay / race) — just stamp the verification flag.
  const existing = await DonationModel.findOneAndUpdate(
    { razorpayOrderId },
    { $set: verifiedFlag },
    { new: true }
  );
  return existing;
}

/** Mark failed only if still pending — a failed attempt never overrides a captured payment. */
export async function markDonationFailed(params: {
  razorpayOrderId: string;
  paymentId?: string;
  reason?: string;
  source: 'callback' | 'webhook';
}): Promise<IDonation | null> {
  const updated = await DonationModel.findOneAndUpdate(
    { razorpayOrderId: params.razorpayOrderId, status: 'created' },
    {
      $set: {
        status: 'failed',
        ...(params.paymentId ? { razorpayPaymentId: params.paymentId } : {}),
        failureReason: (params.reason || 'Payment failed').slice(0, 500),
        ...(params.source === 'webhook' ? { webhookVerified: true } : {}),
      },
    },
    { new: true }
  );

  if (updated) {
    logger.info('Donation marked failed', {
      razorpayOrderId: params.razorpayOrderId,
      reason: params.reason,
      source: params.source,
    });
  }
  return updated;
}

/**
 * Record a refund on a paid donation. Idempotent on razorpayRefundId: replayed
 * webhook events for a refund we already recorded are no-ops.
 */
export async function applyDonationRefund(params: {
  razorpayPaymentId: string;
  razorpayRefundId: string;
  amount: number;
  refundStatus: string;
  reason?: string;
  initiatedBy?: string;
}): Promise<IDonation | null> {
  const donation = await DonationModel.findOne({ razorpayPaymentId: params.razorpayPaymentId });
  if (!donation) return null;

  const existingRefund = donation.refunds.find(
    (r) => r.razorpayRefundId === params.razorpayRefundId
  );

  if (existingRefund) {
    // Replay or status progression (pending -> processed) — update status only.
    if (existingRefund.status !== params.refundStatus) {
      await DonationModel.updateOne(
        { _id: (donation as any)._id, 'refunds.razorpayRefundId': params.razorpayRefundId },
        { $set: { 'refunds.$.status': params.refundStatus } }
      );
    }
    return DonationModel.findById((donation as any)._id);
  }

  const newAmountRefunded = Math.min(donation.amountRefunded + params.amount, donation.amount);
  const newStatus = newAmountRefunded >= donation.amount ? 'refunded' : 'partially_refunded';

  const updated = await DonationModel.findOneAndUpdate(
    {
      _id: (donation as any)._id,
      'refunds.razorpayRefundId': { $ne: params.razorpayRefundId },
    },
    {
      $push: {
        refunds: {
          razorpayRefundId: params.razorpayRefundId,
          amount: params.amount,
          status: params.refundStatus,
          reason: params.reason,
          initiatedBy: params.initiatedBy,
          createdAt: new Date(),
        },
      },
      $set: { amountRefunded: newAmountRefunded, status: newStatus },
    },
    { new: true }
  );

  if (updated) {
    logger.info('Donation refund recorded', {
      razorpayPaymentId: params.razorpayPaymentId,
      razorpayRefundId: params.razorpayRefundId,
      amount: params.amount,
      newStatus,
    });
  }
  return updated || DonationModel.findById((donation as any)._id);
}

// ---------------------------------------------------------------------------
// Receipt email (best-effort, fire-and-forget from callers)
// ---------------------------------------------------------------------------

function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export async function sendDonationReceiptEmail(donation: IDonation): Promise<void> {
  if (!donation.donorEmail || donation.receiptEmailSentAt) return;

  const settings = await getDonationSettings();
  if (!settings.sendReceiptEmail) return;

  const amountStr = formatInr(donation.amount);
  const dateStr = (donation.paidAt || donation.createdAt).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const name = donation.donorName ? escapeHtml(donation.donorName) : 'Supporter';

  const text = [
    `Hi ${donation.donorName || 'there'},`,
    '',
    `Thank you for your donation of ${amountStr} to LinkChat.`,
    '',
    `Receipt number: ${donation.receiptNumber}`,
    `Payment ID: ${donation.razorpayPaymentId || '-'}`,
    `Date: ${dateStr}`,
    '',
    'Your contribution goes directly toward cloud hosting and keeping LinkChat fast, private, and free.',
    '',
    'With gratitude,',
    'The LinkChat Team',
  ].join('\n');

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <div style="background: #2563eb; color: #ffffff; padding: 24px 28px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 20px;">Donation receipt</h1>
        <p style="margin: 6px 0 0; opacity: 0.9; font-size: 13px;">LinkChat</p>
      </div>
      <div style="border: 1px solid #e2e8f0; border-top: 0; padding: 24px 28px; border-radius: 0 0 12px 12px;">
        <p style="font-size: 14px;">Hi ${name},</p>
        <p style="font-size: 14px;">Thank you for supporting LinkChat. Here is your receipt:</p>
        <table style="width: 100%; font-size: 14px; border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 6px 0; color: #64748b;">Amount</td><td style="padding: 6px 0; text-align: right; font-weight: bold;">${amountStr}</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Receipt number</td><td style="padding: 6px 0; text-align: right;">${escapeHtml(donation.receiptNumber)}</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Payment ID</td><td style="padding: 6px 0; text-align: right;">${escapeHtml(donation.razorpayPaymentId || '-')}</td></tr>
          <tr><td style="padding: 6px 0; color: #64748b;">Date</td><td style="padding: 6px 0; text-align: right;">${dateStr}</td></tr>
        </table>
        <p style="font-size: 13px; color: #475569;">Your contribution goes directly toward cloud hosting and keeping LinkChat fast, private, and free for everyone.</p>
        <p style="font-size: 13px; color: #475569;">With gratitude,<br/>The LinkChat Team</p>
      </div>
    </div>`;

  const sent = await sendEmail({
    to: donation.donorEmail,
    subject: `Your LinkChat donation receipt (${donation.receiptNumber})`,
    text,
    html,
  });

  if (sent) {
    await DonationModel.updateOne(
      { _id: (donation as any)._id, receiptEmailSentAt: { $exists: false } },
      { $set: { receiptEmailSentAt: new Date() } }
    ).catch(() => {});
  }
}
