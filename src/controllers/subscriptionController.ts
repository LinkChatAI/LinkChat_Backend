import { Response } from 'express';
import { z } from 'zod';
import { UserAuthRequest } from '../middleware/userAuth.js';
import { AdminUserRequest } from '../middleware/adminRoleAuth.js';
import { UserSubscriptionModel } from '../models/UserSubscription.js';
import { PaymentRecordModel } from '../models/PaymentRecord.js';
import {
  activateSubscription,
  createPurchaseRequest,
  confirmPendingPurchase,
  cancelSubscription,
  renewSubscription,
  SubscriptionError,
} from '../services/subscriptionService.js';
import { logger } from '../utils/logger.js';

const handleServiceError = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof SubscriptionError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logger.error(fallback, { error: error instanceof Error ? error.message : String(error) });
  res.status(500).json({ error: fallback });
};

// ─── User self-service ────────────────────────────────────────────────────────────────────────

export const getMySubscriptionsHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const subscriptions = await UserSubscriptionModel.find({ userId: req.user!.userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ subscriptions });
  } catch (error) {
    logger.error('Failed to fetch subscriptions', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
};

const purchaseRequestSchema = z.object({ planId: z.string().min(1) });

/** Requires login — enforced by authenticateUser on the route. */
export const createPurchaseRequestHandler = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { planId } = purchaseRequestSchema.parse(req.body);
    const result = await createPurchaseRequest(req.user!.userId, planId);
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'planId is required' });
      return;
    }
    handleServiceError(res, error, 'Failed to create purchase request');
  }
};

// ─── Admin billing actions ────────────────────────────────────────────────────────────────────

const grantSubscriptionSchema = z.object({
  userId: z.string().min(1),
  planId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export const grantSubscriptionHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const body = grantSubscriptionSchema.parse(req.body);
    const result = await activateSubscription({
      ...body,
      source: 'admin_grant',
      amountPaid: 0,
      actingAdminId: req.adminUser!.userId,
    });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'userId and planId are required' });
      return;
    }
    handleServiceError(res, error, 'Failed to grant subscription');
  }
};

const recordPaymentSchema = z.object({
  userId: z.string().min(1),
  planId: z.string().min(1),
  amountPaid: z.number().int().min(1),
  reason: z.string().max(500).optional(),
});

/** Admin manually records a completed payment (bank transfer / UPI / cash / other) — no live gateway. */
export const recordPaymentHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const body = recordPaymentSchema.parse(req.body);
    const result = await activateSubscription({
      ...body,
      source: 'admin_recorded_payment',
      actingAdminId: req.adminUser!.userId,
    });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'userId, planId, and amountPaid are required' });
      return;
    }
    handleServiceError(res, error, 'Failed to record payment');
  }
};

export const confirmPurchaseRequestHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await confirmPendingPurchase(id, req.adminUser!.userId);
    res.json(result);
  } catch (error) {
    handleServiceError(res, error, 'Failed to confirm purchase request');
  }
};

export const cancelSubscriptionHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const subscription = await cancelSubscription(id, req.adminUser!.userId);
    res.json({ subscription });
  } catch (error) {
    handleServiceError(res, error, 'Failed to cancel subscription');
  }
};

export const renewSubscriptionHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const subscription = await renewSubscription(id, req.adminUser!.userId);
    res.json({ subscription });
  } catch (error) {
    handleServiceError(res, error, 'Failed to renew subscription');
  }
};

export const listAllSubscriptionsHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { userId, status } = req.query;
    const filter: Record<string, unknown> = {};
    if (typeof userId === 'string') filter.userId = userId;
    if (typeof status === 'string') filter.status = status;

    const subscriptions = await UserSubscriptionModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('userId', 'email name')
      .lean();
    res.json({ subscriptions });
  } catch (error) {
    logger.error('Failed to list subscriptions', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
};

export const listPendingPurchaseRequestsHandler = async (_req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const requests = await UserSubscriptionModel.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .populate('userId', 'email name')
      .lean();
    res.json({ requests });
  } catch (error) {
    logger.error('Failed to list purchase requests', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list purchase requests' });
  }
};

export const listAllPaymentsHandler = async (req: AdminUserRequest, res: Response): Promise<void> => {
  try {
    const { userId } = req.query;
    const filter: Record<string, unknown> = {};
    if (typeof userId === 'string') filter.userId = userId;

    const payments = await PaymentRecordModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('userId', 'email name')
      .lean();
    res.json({ payments });
  } catch (error) {
    logger.error('Failed to list payments', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list payments' });
  }
};
