import { Request, Response } from 'express';
import { z } from 'zod';
import { DonationModel, generateDonationReceiptNumber } from '../models/Donation.js';
import {
  getDonationSettings,
  markDonationPaid,
  markDonationFailed,
  applyDonationRefund,
  sendDonationReceiptEmail,
} from '../services/donationService.js';
import {
  createOrder,
  fetchPayment,
  verifyPaymentSignature,
  verifyWebhookSignature,
  isRazorpayConfigured,
  getRazorpayKeyId,
  RazorpayError,
} from '../services/razorpayService.js';
import { logger } from '../utils/logger.js';

/**
 * Public donation endpoints. Security posture:
 *  - Amounts are validated server-side against admin-configured min/max; the
 *    client can never dictate what Razorpay charges beyond that envelope.
 *  - A payment only ever becomes "paid" through an HMAC-verified source: the
 *    checkout callback signature (plus a server-to-server payment fetch that
 *    re-checks status, order linkage, and amount) or a signature-verified
 *    webhook. Client-reported success alone changes nothing.
 *  - The webhook handler verifies HMAC over the raw request bytes and treats
 *    events idempotently — replays and callback/webhook races are no-ops.
 */

const CreateOrderSchema = z.object({
  amount: z.number().int().min(100).max(50000000), // paise; further clamped by settings
  donorName: z.string().trim().max(100).optional(),
  donorEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
  donorMessage: z.string().trim().max(500).optional(),
});

const VerifySchema = z.object({
  razorpay_order_id: z.string().min(1).max(64),
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_signature: z.string().min(1).max(256),
});

const FailureSchema = z.object({
  razorpay_order_id: z.string().min(1).max(64),
  razorpay_payment_id: z.string().max(64).optional(),
  reason: z.string().max(500).optional(),
});

/** GET /api/donations/config — everything the popup needs to render. */
export const getDonationConfigHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const settings = await getDonationSettings();
    const enabled = settings.enabled && isRazorpayConfigured();

    res.json({
      enabled,
      keyId: enabled ? getRazorpayKeyId() : undefined,
      currency: 'INR',
      minAmount: settings.minAmount,
      maxAmount: settings.maxAmount,
      presetAmounts: settings.presetAmounts,
      title: settings.title,
      message: settings.message,
      thankYouMessage: settings.thankYouMessage,
      methods: {
        upi: settings.upiEnabled,
        card: settings.cardEnabled,
        netbanking: settings.netbankingEnabled,
        wallet: settings.walletEnabled,
      },
    });
  } catch (error: any) {
    logger.error('Failed to load donation config', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to load donation configuration' });
  }
};

/** POST /api/donations/create-order */
export const createDonationOrderHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const settings = await getDonationSettings();
    if (!settings.enabled) {
      res.status(403).json({ error: 'Donations are currently disabled' });
      return;
    }
    if (!isRazorpayConfigured()) {
      res.status(503).json({ error: 'Payment gateway is not configured' });
      return;
    }

    const parsed = CreateOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid donation details' });
      return;
    }
    const { amount, donorName, donorEmail, donorMessage } = parsed.data;

    if (amount < settings.minAmount || amount > settings.maxAmount) {
      res.status(400).json({
        error: `Donation amount must be between ₹${settings.minAmount / 100} and ₹${settings.maxAmount / 100}`,
      });
      return;
    }

    const receiptNumber = generateDonationReceiptNumber();

    const order = await createOrder({
      amount,
      currency: 'INR',
      receipt: receiptNumber,
      notes: {
        purpose: 'LinkChat donation',
        receipt_number: receiptNumber,
        ...(donorName ? { donor_name: donorName.slice(0, 100) } : {}),
      },
    });

    await DonationModel.create({
      razorpayOrderId: order.id,
      amount,
      currency: 'INR',
      status: 'created',
      receiptNumber,
      donorName: donorName || undefined,
      donorEmail: donorEmail || undefined,
      donorMessage: donorMessage || undefined,
      ipAddress: req.ip,
      userAgent: (req.get('user-agent') || '').slice(0, 300),
    });

    logger.info('Donation order created', {
      razorpayOrderId: order.id,
      amount,
      receiptNumber,
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: getRazorpayKeyId(),
      receiptNumber,
    });
  } catch (error: any) {
    if (error instanceof RazorpayError) {
      res.status(error.statusCode >= 500 ? 502 : error.statusCode).json({
        error: 'Could not start the payment. Please try again.',
      });
      return;
    }
    logger.error('Failed to create donation order', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to create donation order' });
  }
};

/**
 * POST /api/donations/verify — checkout success callback.
 * Verifies the HMAC signature, then re-fetches the payment from Razorpay
 * (server-to-server) and cross-checks order linkage, capture status, and amount
 * before marking paid.
 */
export const verifyDonationHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid verification payload' });
      return;
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;

    if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      logger.warn('Donation signature verification failed', {
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        ip: req.ip,
      });
      res.status(400).json({ error: 'Payment verification failed' });
      return;
    }

    const donation = await DonationModel.findOne({ razorpayOrderId: razorpay_order_id });
    if (!donation) {
      res.status(404).json({ error: 'Donation not found' });
      return;
    }

    // Defense in depth: confirm with Razorpay directly.
    const payment = await fetchPayment(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) {
      logger.warn('Donation verify: payment/order mismatch', {
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
      });
      res.status(400).json({ error: 'Payment verification failed' });
      return;
    }
    if (payment.amount !== donation.amount) {
      logger.warn('Donation verify: amount mismatch', {
        razorpayOrderId: razorpay_order_id,
        expected: donation.amount,
        actual: payment.amount,
      });
      res.status(400).json({ error: 'Payment verification failed' });
      return;
    }
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      res.status(400).json({ error: 'Payment is not complete' });
      return;
    }

    const updated = await markDonationPaid({
      razorpayOrderId: razorpay_order_id,
      payment,
      source: 'callback',
    });

    if (updated) {
      sendDonationReceiptEmail(updated).catch((err) =>
        logger.warn('Donation receipt email failed', {
          receiptNumber: updated.receiptNumber,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }

    const settings = await getDonationSettings();
    res.json({
      success: true,
      receiptNumber: donation.receiptNumber,
      amount: donation.amount,
      currency: donation.currency,
      thankYouMessage: settings.thankYouMessage,
    });
  } catch (error: any) {
    if (error instanceof RazorpayError) {
      res.status(502).json({ error: 'Could not verify the payment. Please contact support with your payment ID.' });
      return;
    }
    logger.error('Donation verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Payment verification failed' });
  }
};

/**
 * POST /api/donations/payment-failed — client-side failure report from the
 * checkout popup. Advisory only (webhooks are authoritative): it can only move
 * a still-pending order to "failed", never touch a paid one.
 */
export const reportDonationFailureHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = FailureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }
    await markDonationFailed({
      razorpayOrderId: parsed.data.razorpay_order_id,
      paymentId: parsed.data.razorpay_payment_id,
      reason: parsed.data.reason,
      source: 'callback',
    });
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // advisory endpoint — never surface errors to the payer
  }
};

/**
 * POST /api/donations/webhook — Razorpay webhook receiver.
 * Signature is verified over the raw body (captured by the express.json verify
 * hook in index.ts). Always responds 200 on verified events, even unknown ones,
 * so Razorpay doesn't retry forever.
 */
export const donationWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  const signature = req.get('x-razorpay-signature') || '';
  const rawBody: Buffer | undefined = (req as any).rawBody;

  if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
    logger.warn('Donation webhook rejected: invalid signature', { ip: req.ip });
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    const event = req.body || {};
    const eventType: string = event.event || 'unknown';

    switch (eventType) {
      case 'payment.captured': {
        const payment = event.payload?.payment?.entity;
        if (payment?.order_id) {
          const updated = await markDonationPaid({
            razorpayOrderId: payment.order_id,
            payment,
            source: 'webhook',
          });
          if (updated && updated.status === 'paid') {
            sendDonationReceiptEmail(updated).catch(() => {});
          }
        }
        break;
      }
      case 'payment.failed': {
        const payment = event.payload?.payment?.entity;
        if (payment?.order_id) {
          await markDonationFailed({
            razorpayOrderId: payment.order_id,
            paymentId: payment.id,
            reason: payment.error_description || payment.error_code,
            source: 'webhook',
          });
        }
        break;
      }
      case 'refund.created':
      case 'refund.processed':
      case 'refund.failed': {
        const refund = event.payload?.refund?.entity;
        if (refund?.payment_id) {
          await applyDonationRefund({
            razorpayPaymentId: refund.payment_id,
            razorpayRefundId: refund.id,
            amount: refund.amount,
            refundStatus: refund.status,
          });
        }
        break;
      }
      default:
        logger.debug('Donation webhook: unhandled event', { eventType });
    }

    res.json({ ok: true });
  } catch (error: any) {
    logger.error('Donation webhook processing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // 500 so Razorpay retries — the handlers are idempotent, retries are safe.
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

/**
 * GET /api/donations/receipt/:receiptNumber — public receipt lookup (shown on
 * the thank-you screen / receipt link). Returns only non-sensitive fields.
 */
export const getDonationReceiptHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const receiptNumber = String(req.params.receiptNumber || '').toUpperCase();
    if (!/^LCD-\d{8}-[A-Z0-9]{6}$/.test(receiptNumber)) {
      res.status(400).json({ error: 'Invalid receipt number' });
      return;
    }

    const donation = await DonationModel.findOne({ receiptNumber });
    if (!donation || donation.status === 'created' || donation.status === 'failed') {
      res.status(404).json({ error: 'Receipt not found' });
      return;
    }

    res.json({
      receiptNumber: donation.receiptNumber,
      amount: donation.amount,
      currency: donation.currency,
      status: donation.status,
      donorName: donation.donorName || 'Anonymous',
      paymentMethod: donation.paymentMethod,
      paidAt: donation.paidAt,
    });
  } catch (error: any) {
    logger.error('Receipt lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to load receipt' });
  }
};
