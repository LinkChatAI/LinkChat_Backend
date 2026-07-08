import { Response } from 'express';
import { z } from 'zod';
import { UserAuthRequest } from '../middleware/userAuth.js';
import { AdminUserRequest } from '../middleware/adminRoleAuth.js';
import { UserModel } from '../models/User.js';
import { CreditTransactionModel } from '../models/CreditTransaction.js';
import { grantCredits, SubscriptionError } from '../services/subscriptionService.js';
import { logger } from '../utils/logger.js';

export const getMyCreditsHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const user = await UserModel.findById(req.user!.userId).select('credits').lean();
    const transactions = await CreditTransactionModel.find({ userId: req.user!.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ balance: user?.credits ?? 0, transactions });
  } catch (error) {
    logger.error('Failed to fetch credits', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to fetch credits' });
  }
};

const grantCreditsSchema = z.object({
  userId: z.string().min(1),
  amount: z.number().int().refine((v) => v !== 0, 'amount must not be zero'),
  reason: z.string().max(500).optional(),
});

export const grantCreditsHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const body = grantCreditsSchema.parse(req.body);
    const result = await grantCredits({
      ...body,
      grantedByUserId: req.adminUser!.userId,
    });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'userId and a non-zero integer amount are required' });
      return;
    }
    if (error instanceof SubscriptionError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error('Failed to grant credits', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to grant credits' });
  }
};

export const listCreditTransactionsHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { userId } = req.query;
    const filter: Record<string, unknown> = {};
    if (typeof userId === 'string') filter.userId = userId;

    const transactions = await CreditTransactionModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('userId', 'email name')
      .lean();
    res.json({ transactions });
  } catch (error) {
    logger.error('Failed to list credit transactions', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list credit transactions' });
  }
};
