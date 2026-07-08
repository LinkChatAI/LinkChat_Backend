import mongoose from 'mongoose';
import { UserModel } from '../models/User.js';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan.js';
import { UserSubscriptionModel, SubscriptionSource } from '../models/UserSubscription.js';
import { PaymentRecordModel, generateReceiptNumber } from '../models/PaymentRecord.js';
import { CreditTransactionModel } from '../models/CreditTransaction.js';
import { logger } from '../utils/logger.js';
import {
  sendPurchaseSuccessEmail,
  sendFreeGrantEmail,
  sendCreditAllocationEmail,
  sendSubscriptionRenewalEmail,
  sendSubscriptionExpiryEmail,
} from './notificationEmailService.js';

export class SubscriptionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const PERIOD_MS: Record<string, number> = {
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

const computeExpiry = (billingPeriod: string, from: Date): Date | undefined => {
  const durationMs = PERIOD_MS[billingPeriod];
  return durationMs ? new Date(from.getTime() + durationMs) : undefined; // one_time = lifetime
};

interface ActivateParams {
  userId: string;
  planId: string;
  source: SubscriptionSource;
  reason?: string;
  /** Smallest currency unit. 0 (or omitted) means a free grant. */
  amountPaid?: number;
  /** The admin performing the grant/confirmation — omitted only for a user's own pending purchase request. */
  actingAdminId?: string;
}

/** Grant, confirm, or record a paid purchase of a plan. Handles duplicate-active prevention,
 *  supersedes any different active plan, updates the user's tier + bonus credits, records a
 *  receipt, and sends the appropriate branded emails. */
export const activateSubscription = async (params: ActivateParams) => {
  const { userId, planId, source, reason, amountPaid = 0, actingAdminId } = params;

  const [user, plan] = await Promise.all([
    UserModel.findById(userId),
    SubscriptionPlanModel.findById(planId),
  ]);
  if (!user) throw new SubscriptionError('User not found', 404);
  if (!plan) throw new SubscriptionError('Plan not found', 404);

  const existingSamePlan = await UserSubscriptionModel.findOne({
    userId,
    planId,
    status: 'active',
  });
  if (existingSamePlan) {
    throw new SubscriptionError('This user already has an active subscription to this plan', 409);
  }

  const now = new Date();
  const expiresAt = computeExpiry(plan.billingPeriod, now);

  const subscription = await UserSubscriptionModel.create({
    userId,
    planId,
    planSnapshot: {
      name: plan.name,
      tier: plan.tier,
      price: plan.price,
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
      creditsIncluded: plan.creditsIncluded,
    },
    status: 'active',
    source,
    startedAt: now,
    expiresAt,
    grantedBy: actingAdminId,
    reason,
  });

  // Supersede any other active subscription (different plan) — a user shows one active plan at a time.
  await UserSubscriptionModel.updateMany(
    { userId, status: 'active', _id: { $ne: subscription._id } },
    { status: 'cancelled', cancelledAt: now, cancelledBy: actingAdminId }
  );

  user.plan = plan.tier;
  await user.save();

  const receiptNumber = generateReceiptNumber();
  const payment = await PaymentRecordModel.create({
    userId,
    planId,
    subscriptionId: subscription._id,
    amount: amountPaid,
    currency: plan.currency,
    status: 'confirmed',
    method: amountPaid > 0 ? 'admin_manual' : 'free_grant',
    receiptNumber,
    recordedBy: actingAdminId,
    confirmedBy: actingAdminId,
    confirmedAt: now,
  });

  if (plan.creditsIncluded > 0) {
    await grantCredits({
      userId,
      amount: plan.creditsIncluded,
      reason: `Included with ${plan.name} plan`,
      grantedByUserId: actingAdminId,
      skipEmail: true, // the purchase/grant email already covers this — avoid a second email for the same action
    });
  }

  const admin = actingAdminId ? await UserModel.findById(actingAdminId).select('email').lean() : null;
  const emailPlan = { name: plan.name, tier: plan.tier, price: plan.price, currency: plan.currency, billingPeriod: plan.billingPeriod };
  const emailUser = { email: user.email, name: user.name };

  if (amountPaid > 0) {
    sendPurchaseSuccessEmail(emailUser, emailPlan, receiptNumber).catch((err) =>
      logger.warn('Purchase success email failed', { error: err instanceof Error ? err.message : String(err) })
    );
  } else {
    sendFreeGrantEmail(emailUser, emailPlan, reason, admin?.email || 'LinkChat Admin').catch((err) =>
      logger.warn('Free grant email failed', { error: err instanceof Error ? err.message : String(err) })
    );
  }

  return { subscription, payment };
};

/** A logged-in user's self-service request to purchase a plan — stays 'pending' until an
 *  admin records/confirms the payment (see `confirmPendingPurchase`). No email is sent for the
 *  request itself; the confirmation email fires once the admin confirms payment. */
export const createPurchaseRequest = async (userId: string, planId: string) => {
  const [user, plan] = await Promise.all([
    UserModel.findById(userId).select('_id').lean(),
    SubscriptionPlanModel.findById(planId),
  ]);
  if (!user) throw new SubscriptionError('User not found', 404);
  if (!plan || !plan.isActive) throw new SubscriptionError('Plan not found or not available', 404);

  const existingActive = await UserSubscriptionModel.findOne({ userId, planId, status: 'active' });
  if (existingActive) {
    throw new SubscriptionError('You already have an active subscription to this plan', 409);
  }
  const existingPending = await UserSubscriptionModel.findOne({ userId, planId, status: 'pending' });
  if (existingPending) {
    throw new SubscriptionError('You already have a pending purchase request for this plan', 409);
  }

  const subscription = await UserSubscriptionModel.create({
    userId,
    planId,
    planSnapshot: {
      name: plan.name,
      tier: plan.tier,
      price: plan.price,
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
      creditsIncluded: plan.creditsIncluded,
    },
    status: 'pending',
    source: 'purchase_request',
  });

  const payment = await PaymentRecordModel.create({
    userId,
    planId,
    subscriptionId: subscription._id,
    amount: plan.price,
    currency: plan.currency,
    status: 'pending',
    method: 'other',
    receiptNumber: generateReceiptNumber(),
  });

  return { subscription, payment };
};

/** Admin confirms a user's pending purchase request — activates it via the same path as a
 *  direct admin-recorded payment, and marks the pending PaymentRecord confirmed. */
export const confirmPendingPurchase = async (subscriptionId: string, actingAdminId: string) => {
  const pending = await UserSubscriptionModel.findById(subscriptionId);
  if (!pending) throw new SubscriptionError('Purchase request not found', 404);
  if (pending.status !== 'pending') throw new SubscriptionError('This request is no longer pending', 409);

  await UserSubscriptionModel.deleteOne({ _id: pending._id }); // superseded by the freshly-activated one below
  await PaymentRecordModel.deleteOne({ subscriptionId: pending._id, status: 'pending' });

  return activateSubscription({
    userId: String(pending.userId),
    planId: String(pending.planId),
    source: 'admin_recorded_payment',
    amountPaid: pending.planSnapshot.price,
    actingAdminId,
  });
};

export const cancelSubscription = async (subscriptionId: string, cancelledBy?: string) => {
  const subscription = await UserSubscriptionModel.findById(subscriptionId);
  if (!subscription) throw new SubscriptionError('Subscription not found', 404);

  subscription.status = 'cancelled';
  subscription.cancelledAt = new Date();
  subscription.cancelledBy = cancelledBy ? new mongoose.Types.ObjectId(cancelledBy) : undefined;
  await subscription.save();

  const stillActive = await UserSubscriptionModel.findOne({ userId: subscription.userId, status: 'active' });
  if (!stillActive) {
    await UserModel.findByIdAndUpdate(subscription.userId, { plan: 'free' });
  }

  return subscription;
};

interface GrantCreditsParams {
  userId: string;
  amount: number;
  reason?: string;
  grantedByUserId?: string;
  skipEmail?: boolean;
}

/** Adjust a user's credit balance and append a ledger entry. `amount` may be negative for usage/debits. */
export const grantCredits = async ({ userId, amount, reason, grantedByUserId, skipEmail }: GrantCreditsParams) => {
  const user = await UserModel.findById(userId);
  if (!user) throw new SubscriptionError('User not found', 404);

  const balanceAfter = user.credits + amount;
  if (balanceAfter < 0) throw new SubscriptionError('Insufficient credit balance', 400);

  user.credits = balanceAfter;
  await user.save();

  const transaction = await CreditTransactionModel.create({
    userId,
    amount,
    balanceAfter,
    type: amount >= 0 ? 'admin_grant' : 'usage',
    reason,
    grantedBy: grantedByUserId,
  });

  if (!skipEmail && amount > 0) {
    const admin = grantedByUserId ? await UserModel.findById(grantedByUserId).select('email').lean() : null;
    sendCreditAllocationEmail(
      { email: user.email, name: user.name },
      amount,
      balanceAfter,
      reason,
      admin?.email || 'LinkChat Admin'
    ).catch((err) => logger.warn('Credit allocation email failed', { error: err instanceof Error ? err.message : String(err) }));
  }

  return { transaction, balanceAfter };
};

/** Extends an active subscription's expiry by one more billing period and emails the user. */
export const renewSubscription = async (subscriptionId: string, actingAdminId?: string) => {
  const subscription = await UserSubscriptionModel.findById(subscriptionId);
  if (!subscription) throw new SubscriptionError('Subscription not found', 404);
  if (subscription.status !== 'active') throw new SubscriptionError('Only active subscriptions can be renewed', 409);

  const base = subscription.expiresAt && subscription.expiresAt > new Date() ? subscription.expiresAt : new Date();
  const nextExpiry = computeExpiry(subscription.planSnapshot.billingPeriod, base);
  if (!nextExpiry) throw new SubscriptionError('One-time plans do not expire and cannot be renewed', 400);

  subscription.expiresAt = nextExpiry;
  await subscription.save();

  const user = await UserModel.findById(subscription.userId).select('email name').lean();
  if (user) {
    sendSubscriptionRenewalEmail(
      { email: user.email, name: user.name },
      { name: subscription.planSnapshot.name, tier: subscription.planSnapshot.tier, price: subscription.planSnapshot.price, currency: subscription.planSnapshot.currency, billingPeriod: subscription.planSnapshot.billingPeriod },
      nextExpiry
    ).catch((err) => logger.warn('Renewal email failed', { error: err instanceof Error ? err.message : String(err) }));
  }

  return subscription;
};

/** Periodic sweep — expires subscriptions past their expiresAt, reverts the user to Free, and
 *  emails them. Mirrors the interval-worker pattern used by autoVanishService. */
export const expireDueSubscriptions = async (): Promise<number> => {
  const due = await UserSubscriptionModel.find({
    status: 'active',
    expiresAt: { $lte: new Date() },
  });

  for (const subscription of due) {
    try {
      subscription.status = 'expired';
      await subscription.save();

      const stillActive = await UserSubscriptionModel.findOne({ userId: subscription.userId, status: 'active' });
      const user = await UserModel.findById(subscription.userId);
      if (user) {
        if (!stillActive) user.plan = 'free';
        await user.save();

        sendSubscriptionExpiryEmail(
          { email: user.email, name: user.name },
          {
            name: subscription.planSnapshot.name,
            tier: subscription.planSnapshot.tier,
            price: subscription.planSnapshot.price,
            currency: subscription.planSnapshot.currency,
            billingPeriod: subscription.planSnapshot.billingPeriod,
          }
        ).catch((err) => logger.warn('Expiry email failed', { error: err instanceof Error ? err.message : String(err) }));
      }
    } catch (error: unknown) {
      logger.error('Failed to expire subscription', {
        subscriptionId: String(subscription._id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (due.length > 0) {
    logger.info(`Expired ${due.length} subscription(s)`);
  }
  return due.length;
};
