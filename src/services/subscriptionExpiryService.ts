import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { expireDueSubscriptions } from './subscriptionService.js';
import { recordJobRun } from './jobHealthService.js';

// Checks for due subscriptions every 15 minutes — expiry timing doesn't need auto-vanish's
// 5-minute precision, and billing periods are measured in days/months.
const SUBSCRIPTION_EXPIRY_INTERVAL_MS = parseInt(
  process.env.SUBSCRIPTION_EXPIRY_INTERVAL_MS || '900000',
  10
);

const runExpirySweep = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 1) {
    logger.debug('Database not connected, skipping subscription expiry sweep');
    return;
  }
  try {
    await recordJobRun('subscription-expiry', expireDueSubscriptions);
  } catch (error: unknown) {
    logger.error('Subscription expiry sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Start the subscription-expiry background worker. Mirrors autoVanishService's
 * startAutoVanishWorker pattern: run once immediately, then on a fixed interval.
 */
export const startSubscriptionExpiryWorker = (): NodeJS.Timeout => {
  logger.info('Starting subscription expiry worker', { intervalMs: SUBSCRIPTION_EXPIRY_INTERVAL_MS });

  runExpirySweep();

  return setInterval(() => {
    runExpirySweep();
  }, SUBSCRIPTION_EXPIRY_INTERVAL_MS);
};
