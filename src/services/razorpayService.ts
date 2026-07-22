import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Thin Razorpay REST client. Uses the platform's global fetch (Node 20+)
 * instead of the razorpay SDK — the three calls we need (create order, fetch
 * payment, create refund) are simple enough that a dependency isn't worth it,
 * and it keeps signature verification fully under our control.
 *
 * All amounts are in paise. Secrets never leave this module: key_secret is
 * only used for Basic auth + HMAC, and is never logged or returned.
 */

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 15000;

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string; // created | authorized | captured | refunded | failed
  method?: string; // upi | card | netbanking | wallet | emi
  vpa?: string;
  bank?: string;
  wallet?: string;
  card?: { network?: string; last4?: string };
  email?: string;
  contact?: string;
  error_code?: string;
  error_description?: string;
  amount_refunded?: number;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: string; // pending | processed | failed
}

export class RazorpayError extends Error {
  statusCode: number;
  razorpayCode?: string;

  constructor(message: string, statusCode: number, razorpayCode?: string) {
    super(message);
    this.name = 'RazorpayError';
    this.statusCode = statusCode;
    this.razorpayCode = razorpayCode;
  }
}

export function isRazorpayConfigured(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export function getRazorpayKeyId(): string {
  return env.RAZORPAY_KEY_ID || '';
}

function getAuthHeader(): string {
  const credentials = `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

async function razorpayRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  if (!isRazorpayConfigured()) {
    throw new RazorpayError('Razorpay is not configured on the server', 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${RAZORPAY_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error: any) {
    const isAbort = error?.name === 'AbortError';
    logger.error('Razorpay API request failed', {
      path,
      method,
      error: isAbort ? 'timeout' : error instanceof Error ? error.message : String(error),
    });
    throw new RazorpayError(
      isAbort ? 'Payment gateway timed out' : 'Payment gateway unreachable',
      502
    );
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const rzpError = (data as any)?.error || {};
    logger.error('Razorpay API error response', {
      path,
      method,
      status: response.status,
      code: rzpError.code,
      description: rzpError.description,
    });
    throw new RazorpayError(
      rzpError.description || 'Payment gateway error',
      response.status,
      rzpError.code
    );
  }

  return data as T;
}

/** Create a Razorpay order. `notes` show up in the Razorpay dashboard for reconciliation. */
export async function createOrder(params: {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  return razorpayRequest<RazorpayOrder>('POST', '/orders', {
    amount: params.amount,
    currency: params.currency,
    receipt: params.receipt,
    notes: params.notes,
    // Auto-capture regardless of the account's default setting — donations have
    // no fulfillment step to gate a manual capture on.
    payment_capture: 1,
  });
}

export async function fetchPayment(paymentId: string): Promise<RazorpayPayment> {
  return razorpayRequest<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
}

/** Full refund when `amount` is omitted, partial otherwise (paise). */
export async function createRefund(
  paymentId: string,
  amount?: number,
  notes?: Record<string, string>
): Promise<RazorpayRefund> {
  const body: Record<string, unknown> = { speed: 'normal' };
  if (typeof amount === 'number') body.amount = amount;
  if (notes) body.notes = notes;
  return razorpayRequest<RazorpayRefund>(
    'POST',
    `/payments/${encodeURIComponent(paymentId)}/refund`,
    body
  );
}

function timingSafeHmacCheck(payload: string, secret: string, expectedSignature: string): boolean {
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const computedBuf = Buffer.from(computed, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  if (computedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, expectedBuf);
}

/**
 * Verify the checkout-callback signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret).
 * This is the proof that the payment result actually came from Razorpay and not
 * a forged client callback.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  if (!env.RAZORPAY_KEY_SECRET || !signature) return false;
  return timingSafeHmacCheck(`${orderId}|${paymentId}`, env.RAZORPAY_KEY_SECRET, signature);
}

/**
 * Verify a webhook signature: HMAC-SHA256(raw request body, webhook_secret).
 * Must be computed over the exact raw bytes Express received (req.rawBody),
 * not a re-serialized JSON.stringify of the parsed body.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return timingSafeHmacCheck(payload, env.RAZORPAY_WEBHOOK_SECRET, signature);
}
