import { Response } from 'express';
import { z } from 'zod';
import { AdminUserRequest } from '../middleware/adminRoleAuth.js';
import { UserModel } from '../models/User.js';
import { UserSubscriptionModel } from '../models/UserSubscription.js';
import { CreditTransactionModel } from '../models/CreditTransaction.js';
import { PaymentRecordModel } from '../models/PaymentRecord.js';
import { sendAccountStatusEmail } from '../services/notificationEmailService.js';
import { logger } from '../utils/logger.js';

export const listUsersHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { search, status, role, page = '1', limit = '50' } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (typeof search === 'string' && search.trim()) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ email: re }, { name: re }];
    }
    if (typeof status === 'string' && status) filter.status = status;
    if (typeof role === 'string' && role) filter.role = role;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    const [users, total] = await Promise.all([
      UserModel.find(filter)
        .select('-refreshTokenHash')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      UserModel.countDocuments(filter),
    ]);

    res.json({ users, total, page: pageNum, limit: limitNum });
  } catch (error) {
    logger.error('Failed to list users', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list users' });
  }
};

/** Full drill-down for one user: profile + subscriptions + payments + credit ledger. */
export const getUserDetailHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = await UserModel.findById(id).select('-refreshTokenHash').lean();
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [subscriptions, payments, creditTransactions] = await Promise.all([
      UserSubscriptionModel.find({ userId: id }).sort({ createdAt: -1 }).lean(),
      PaymentRecordModel.find({ userId: id }).sort({ createdAt: -1 }).lean(),
      CreditTransactionModel.find({ userId: id }).sort({ createdAt: -1 }).limit(100).lean(),
    ]);

    res.json({ user, subscriptions, payments, creditTransactions });
  } catch (error) {
    logger.error('Failed to fetch user detail', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to fetch user detail' });
  }
};

const statusChangeSchema = z.object({
  status: z.enum(['active', 'suspended', 'banned']),
  reason: z.string().max(500).optional(),
});

export const changeUserStatusHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, reason } = statusChangeSchema.parse(req.body);

    if (id === req.adminUser!.userId) {
      res.status(400).json({ error: 'You cannot change your own account status' });
      return;
    }

    const user = await UserModel.findById(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const previousStatus = user.status;
    user.status = status;
    user.statusReason = reason;
    user.statusChangedAt = new Date();
    user.statusChangedBy = req.adminUser!.userId as any;
    await user.save();

    if (previousStatus !== status) {
      const change = status === 'active' ? 'reactivated' : status === 'suspended' ? 'suspended' : 'banned';
      sendAccountStatusEmail(
        { email: user.email, name: user.name },
        change,
        reason,
        req.adminUser!.email
      ).catch((err) => logger.warn('Account status email failed', { error: err instanceof Error ? err.message : String(err) }));
    }

    res.json({ user: user.toObject({ getters: false, virtuals: false }) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'status must be one of active, suspended, banned' });
      return;
    }
    logger.error('Failed to change user status', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to change user status' });
  }
};

export const verifyUserHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = await UserModel.findByIdAndUpdate(
      id,
      { isVerified: true, verifiedAt: new Date(), verifiedBy: req.adminUser!.userId },
      { new: true }
    ).select('-refreshTokenHash');
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (error) {
    logger.error('Failed to verify user', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to verify user' });
  }
};

const roleChangeSchema = z.object({ role: z.enum(['user', 'admin']) });

export const changeUserRoleHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { role } = roleChangeSchema.parse(req.body);

    if (id === req.adminUser!.userId && role === 'user') {
      res.status(400).json({ error: 'You cannot remove your own admin role' });
      return;
    }

    const user = await UserModel.findByIdAndUpdate(id, { role }, { new: true }).select('-refreshTokenHash');
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'role must be user or admin' });
      return;
    }
    logger.error('Failed to change user role', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to change user role' });
  }
};
