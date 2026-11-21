// Razorpay's API, from the server (https://razorpay.com/docs/payments/subscriptions/integration-guide):
// plans and subscriptions (Basic auth with the key id and secret), checking the payment signature Checkout
// returns, and checking webhook signatures.
//
//   RAZORPAY_KEY_ID          public key id (also given to the app for Checkout)
//   RAZORPAY_KEY_SECRET      Secret Manager
//   RAZORPAY_WEBHOOK_SECRET  Secret Manager (the secret set on the webhook in the Razorpay dashboard)
//   RAZORPAY_BASE_URL        optional, for tests
import { createHmac, timingSafeEqual } from 'node:crypto';

const base = () => process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com';
export const keyId = () => process.env.RAZORPAY_KEY_ID || '';
export const configured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
export const webhookConfigured = () => !!process.env.RAZORPAY_WEBHOOK_SECRET;

export class RazorpayError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${base()}/v1${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
        'content-type': 'application/json', accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) { throw new RazorpayError(`Razorpay unreachable: ${e.message}`); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new RazorpayError(`Razorpay ${method} ${path}: HTTP ${res.status} ${j.error?.code || ''} ${j.error?.description || ''}`.trim(), res.status >= 500 ? 502 : 400);
  return j;
}

/** A monthly plan at this price. → plan id */
export async function createPlan(priceInr) {
  const p = await call('POST', '/plans', {
    period: 'monthly', interval: 1,
    item: { name: `Adam learning · ₹${priceInr}/month`, amount: priceInr * 100, currency: 'INR', description: 'Practice conversations and lessons with Sakhi' },
    notes: { product: 'learning' },
  });
  return p.id;
}

/** A subscription for one learner (up to 10 years of monthly charges; they can cancel any time). */
export const createSubscription = ({ planId, userId }) => call('POST', '/subscriptions', {
  plan_id: planId, total_count: 120, quantity: 1, customer_notify: true, notes: { user_id: userId },
});

export const fetchSubscription = (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`);

/** Cancel: at the end of the paid month (the default), or now. */
export const cancelSubscription = (id, { atCycleEnd = true } = {}) =>
  call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });

const hmac = (data, secret) => createHmac('sha256', secret).update(data).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Checkout's answer is genuine: HMAC-SHA256(payment_id + "|" + subscription_id, key secret). The subscription id
 * must be the one this server created, never the one Checkout returns.
 */
export const paymentSignatureOk = ({ paymentId, subscriptionId, signature }) =>
  !!(paymentId && subscriptionId && signature) && same(hmac(`${paymentId}|${subscriptionId}`, process.env.RAZORPAY_KEY_SECRET || ''), signature);

/** A webhook is genuine: HMAC-SHA256 of the raw body with the webhook secret (X-Razorpay-Signature). */
export const webhookSignatureOk = (rawBody, signature) =>
  webhookConfigured() && !!signature && same(hmac(rawBody, process.env.RAZORPAY_WEBHOOK_SECRET), signature);

const ts = (s) => (s ? new Date(s * 1000) : null);
/** The parts of a Razorpay subscription we keep. */
export const subscriptionState = (s) => ({ status: s.status, currentStart: ts(s.current_start), currentEnd: ts(s.current_end), planId: s.plan_id });
