import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { DonationModel } from '../models/Donation.js';
import { AdminRequest } from '../middleware/adminAuth.js';
import {
  getDonationSettings,
  updateDonationSettings,
  applyDonationRefund,
  markDonationPaid,
  markDonationFailed,
} from '../services/donationService.js';
import {
  createRefund,
  fetchPayment,
  isRazorpayConfigured,
  RazorpayError,
} from '../services/razorpayService.js';
import { logger } from '../utils/logger.js';

/** Admin donation management. All routes sit behind authenticateAdmin + audit. */

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['created', 'paid', 'failed', 'refunded', 'partially_refunded']).optional(),
  method: z.string().max(30).optional(),
  q: z.string().max(120).optional(),
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildListFilter(query: z.infer<typeof ListQuerySchema>): Record<string, any> {
  const filter: Record<string, any> = {};
  if (query.status) filter.status = query.status;
  if (query.method) filter.paymentMethod = query.method;
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q.trim()), 'i');
    filter.$or = [
      { receiptNumber: rx },
      { razorpayOrderId: rx },
      { razorpayPaymentId: rx },
      { donorName: rx },
      { donorEmail: rx },
    ];
  }
  const createdAt: Record<string, Date> = {};
  if (query.from) {
    const d = new Date(query.from);
    if (!isNaN(d.getTime())) createdAt.$gte = d;
  }
  if (query.to) {
    const d = new Date(query.to);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      createdAt.$lte = d;
    }
  }
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;
  return filter;
}

/** GET /list — paginated, filterable transaction table. */
export const listDonationsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters' });
      return;
    }
    const query = parsed.data;
    const filter = buildListFilter(query);

    const [items, total] = await Promise.all([
      DonationModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      DonationModel.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page: query.page,
      pages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error: any) {
    logger.error('Admin donation list failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to load donations' });
  }
};

/** GET /stats — headline totals + 30-day daily series + method breakdown. */
export const donationStatsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const paidStatuses = ['paid', 'refunded', 'partially_refunded'];
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [totals, byMethod, daily, recentFailures] = await Promise.all([
      DonationModel.aggregate([
        { $match: { status: { $in: paidStatuses } } },
        {
          $group: {
            _id: null,
            grossAmount: { $sum: '$amount' },
            refundedAmount: { $sum: '$amountRefunded' },
            count: { $sum: 1 },
            avgAmount: { $avg: '$amount' },
          },
        },
      ]),
      DonationModel.aggregate([
        { $match: { status: { $in: paidStatuses } } },
        { $group: { _id: '$paymentMethod', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { amount: -1 } },
      ]),
      DonationModel.aggregate([
        { $match: { status: { $in: paidStatuses }, paidAt: { $gte: since30d } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
            amount: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      DonationModel.countDocuments({ status: 'failed', createdAt: { $gte: since30d } }),
    ]);

    const t = totals[0] || { grossAmount: 0, refundedAmount: 0, count: 0, avgAmount: 0 };

    res.json({
      grossAmount: t.grossAmount,
      refundedAmount: t.refundedAmount,
      netAmount: t.grossAmount - t.refundedAmount,
      count: t.count,
      avgAmount: Math.round(t.avgAmount || 0),
      failedLast30Days: recentFailures,
      byMethod: byMethod.map((m: any) => ({
        method: m._id || 'unknown',
        amount: m.amount,
        count: m.count,
      })),
      daily: daily.map((d: any) => ({ date: d._id, amount: d.amount, count: d.count })),
    });
  } catch (error: any) {
    logger.error('Admin donation stats failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to load donation stats' });
  }
};

/** GET /:id — full detail incl. refund history for the receipt/detail modal. */
export const getDonationHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ error: 'Invalid donation id' });
      return;
    }
    const donation = await DonationModel.findById(req.params.id).lean();
    if (!donation) {
      res.status(404).json({ error: 'Donation not found' });
      return;
    }
    res.json(donation);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load donation' });
  }
};

const RefundSchema = z.object({
  amount: z.number().int().min(100).optional(), // paise; omitted = full remaining refund
  reason: z.string().trim().max(300).optional(),
});

/** POST /:id/refund — full or partial refund via the Razorpay API. */
export const refundDonationHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (!isRazorpayConfigured()) {
      res.status(503).json({ error: 'Payment gateway is not configured' });
      return;
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ error: 'Invalid donation id' });
      return;
    }
    const parsed = RefundSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid refund request' });
      return;
    }

    const donation = await DonationModel.findById(req.params.id);
    if (!donation) {
      res.status(404).json({ error: 'Donation not found' });
      return;
    }
    if (!donation.razorpayPaymentId) {
      res.status(400).json({ error: 'Donation has no captured payment to refund' });
      return;
    }
    if (donation.status !== 'paid' && donation.status !== 'partially_refunded') {
      res.status(400).json({ error: `Cannot refund a donation with status "${donation.status}"` });
      return;
    }

    const refundable = donation.amount - donation.amountRefunded;
    const amount = parsed.data.amount ?? refundable;
    if (amount <= 0 || amount > refundable) {
      res.status(400).json({
        error: `Refund amount must be between ₹1 and ₹${refundable / 100} (remaining refundable)`,
      });
      return;
    }

    const refund = await createRefund(donation.razorpayPaymentId, amount, {
      reason: parsed.data.reason || 'Admin-initiated refund',
      receipt_number: donation.receiptNumber,
    });

    const updated = await applyDonationRefund({
      razorpayPaymentId: donation.razorpayPaymentId,
      razorpayRefundId: refund.id,
      amount: refund.amount,
      refundStatus: refund.status,
      reason: parsed.data.reason,
      initiatedBy: req.adminId,
    });

    logger.info('Admin refund issued', {
      donationId: String(donation._id),
      razorpayRefundId: refund.id,
      amount: refund.amount,
      adminId: req.adminId,
    });

    res.json({ success: true, donation: updated });
  } catch (error: any) {
    if (error instanceof RazorpayError) {
      res.status(error.statusCode >= 500 ? 502 : 400).json({
        error: `Refund failed: ${error.message}`,
      });
      return;
    }
    logger.error('Admin refund failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Refund failed' });
  }
};

/**
 * POST /:id/sync — re-fetch payment state from Razorpay and reconcile. Covers
 * missed webhooks (e.g. downtime) without waiting for Razorpay retries.
 */
export const syncDonationHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ error: 'Invalid donation id' });
      return;
    }
    const donation = await DonationModel.findById(req.params.id);
    if (!donation) {
      res.status(404).json({ error: 'Donation not found' });
      return;
    }
    if (!donation.razorpayPaymentId) {
      res.status(400).json({ error: 'No payment ID recorded yet — nothing to sync' });
      return;
    }

    const payment = await fetchPayment(donation.razorpayPaymentId);

    if ((payment.status === 'captured' || payment.status === 'authorized') && donation.status === 'created') {
      await markDonationPaid({
        razorpayOrderId: donation.razorpayOrderId,
        payment,
        source: 'webhook',
      });
    } else if (payment.status === 'failed' && donation.status === 'created') {
      await markDonationFailed({
        razorpayOrderId: donation.razorpayOrderId,
        paymentId: payment.id,
        reason: payment.error_description || payment.error_code,
        source: 'webhook',
      });
    }

    const fresh = await DonationModel.findById(req.params.id).lean();
    res.json({ success: true, donation: fresh, gatewayStatus: payment.status });
  } catch (error: any) {
    if (error instanceof RazorpayError) {
      res.status(502).json({ error: `Gateway sync failed: ${error.message}` });
      return;
    }
    res.status(500).json({ error: 'Sync failed' });
  }
};

const NoteSchema = z.object({ note: z.string().trim().max(1000) });

/** POST /:id/note */
export const setDonationNoteHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ error: 'Invalid donation id' });
      return;
    }
    const parsed = NoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid note' });
      return;
    }
    const donation = await DonationModel.findByIdAndUpdate(
      req.params.id,
      { $set: { adminNote: parsed.data.note } },
      { new: true }
    ).lean();
    if (!donation) {
      res.status(404).json({ error: 'Donation not found' });
      return;
    }
    res.json({ success: true, donation });
  } catch {
    res.status(500).json({ error: 'Failed to save note' });
  }
};

/** GET /settings */
export const getDonationSettingsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const settings = await getDonationSettings();
    res.json({ settings, gatewayConfigured: isRazorpayConfigured() });
  } catch {
    res.status(500).json({ error: 'Failed to load donation settings' });
  }
};

const SettingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    minAmount: z.number().int().min(100).max(10000000),
    maxAmount: z.number().int().min(100).max(50000000),
    presetAmounts: z.array(z.number().int().min(100)).min(1).max(6),
    title: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(1000),
    thankYouMessage: z.string().trim().min(1).max(500),
    upiEnabled: z.boolean(),
    cardEnabled: z.boolean(),
    netbankingEnabled: z.boolean(),
    walletEnabled: z.boolean(),
    sendReceiptEmail: z.boolean(),
  })
  .partial();

/** PUT /settings */
export const updateDonationSettingsHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid settings payload' });
      return;
    }
    const patch = parsed.data;

    const current = await getDonationSettings();
    const min = patch.minAmount ?? current.minAmount;
    const max = patch.maxAmount ?? current.maxAmount;
    if (min > max) {
      res.status(400).json({ error: 'Minimum amount cannot exceed maximum amount' });
      return;
    }

    const settings = await updateDonationSettings(patch, req.adminId);
    logger.info('Donation settings updated', { adminId: req.adminId, patch: Object.keys(patch) });
    res.json({ settings, gatewayConfigured: isRazorpayConfigured() });
  } catch (error: any) {
    logger.error('Donation settings update failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to update donation settings' });
  }
};

/** GET /export.csv — filtered CSV download for accounting. */
export const exportDonationsCsvHandler = async (req: AdminRequest, res: Response): Promise<void> => {
  try {
    const parsed = ListQuerySchema.safeParse(req.query);
    const filter = parsed.success ? buildListFilter(parsed.data) : {};

    const rows = await DonationModel.find(filter).sort({ createdAt: -1 }).limit(10000).lean();

    const csvEscape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = [
      'receipt_number', 'status', 'amount_inr', 'refunded_inr', 'currency', 'method',
      'method_detail', 'donor_name', 'donor_email', 'razorpay_order_id',
      'razorpay_payment_id', 'created_at', 'paid_at',
    ].join(',');

    const lines = rows.map((d) =>
      [
        d.receiptNumber, d.status, (d.amount / 100).toFixed(2), (d.amountRefunded / 100).toFixed(2),
        d.currency, d.paymentMethod || '', d.paymentMethodDetail || '', d.donorName || '',
        d.donorEmail || '', d.razorpayOrderId, d.razorpayPaymentId || '',
        d.createdAt?.toISOString() || '', d.paidAt?.toISOString() || '',
      ].map(csvEscape).join(',')
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="linkchat-donations-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send([header, ...lines].join('\n'));
  } catch (error: any) {
    logger.error('Donation CSV export failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Export failed' });
  }
};
