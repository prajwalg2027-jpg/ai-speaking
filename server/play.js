// Google Play's side of payments, from the server, with the Google Play Developer API
// (https://developer.android.com/google/play/billing/backend): checking a Play subscription purchase, acknowledging
// it, cancelling it, and reporting Razorpay payments that learners chose on Play's "user choice billing" screen
// (https://developer.android.com/google/play/billing/alternative/reporting).
//
//   PLAY_PACKAGE_NAME  the app on Play (in.adamspeaks.app)
//   PLAY_PRODUCT_ID    the subscription product made in Play Console (e.g. learning_monthly)
//   PLAY_RTDN_TOKEN    Secret Manager: the secret in the Pub/Sub push URL for Play's real-time notifications
//   PLAY_BASE_URL, PLAY_ACCESS_TOKEN  optional, for tests (otherwise Cloud Run's own service account, which must be
//                      invited in Play Console › Users and permissions)
import { accessToken } from './gcp.js';
import * as settings from './settings.js';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const base = () => process.env.PLAY_BASE_URL || 'https://androidpublisher.googleapis.com';
export const packageName = () => process.env.PLAY_PACKAGE_NAME || '';
export const productId = () => process.env.PLAY_PRODUCT_ID || '';
export const configured = () => !!(packageName() && productId());
export const rtdnToken = () => process.env.PLAY_RTDN_TOKEN || '';

export class PlayError extends Error {
  constructor(message, status = 502, code = 'play_error') { super(message); this.status = status; this.error = code; }
}

const enc = encodeURIComponent;
async function call(method, path, body) {
  const token = process.env.PLAY_ACCESS_TOKEN || (await accessToken(SCOPE));
  let res;
  try {
    res = await fetch(`${base()}/androidpublisher/v3/applications/${enc(packageName())}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) { throw new PlayError(`Google Play unreachable: ${e.message}`); }
  const text = await res.text();
  const j = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
  // 400/404/410: Google doesn't know this purchase (made up, from another app, or long expired).
  if ([400, 404, 410].includes(res.status)) throw new PlayError(`Google Play ${method} ${path.split('/tokens/')[0]}: HTTP ${res.status} ${j.error?.message || ''}`.trim(), 400, 'purchase_not_found');
  if (res.status === 409) throw new PlayError('Google Play: already exists', 409, 'already_exists'); // e.g. a transaction already reported
  if (!res.ok) throw new PlayError(`Google Play ${method}: HTTP ${res.status} ${j.error?.message || ''}`.trim());
  return j;
}

/** A subscription purchase, as Google sees it (purchases.subscriptionsv2.get). */
export const fetchSubscription = (purchaseToken) => call('GET', `/purchases/subscriptionsv2/tokens/${enc(purchaseToken)}`);

/** Acknowledge a new purchase: Google refunds purchases that aren't acknowledged within 3 days. */
export const acknowledge = (purchaseToken, product = productId()) =>
  call('POST', `/purchases/subscriptions/${enc(product)}/tokens/${enc(purchaseToken)}:acknowledge`, {});

/** Stop renewing (access lasts to the end of the paid month). */
export const cancel = (purchaseToken, product = productId()) =>
  call('POST', `/purchases/subscriptions/${enc(product)}/tokens/${enc(purchaseToken)}:cancel`);

// Google's subscription states → the names subscriptions.status already uses (Razorpay's), so access rules are shared.
const STATES = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'pending', // renewal failing, Google retrying: access continues
  SUBSCRIPTION_STATE_ON_HOLD: 'halted',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_CANCELED: 'cancelled', // won't renew; access to the end of the paid month
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'created', // payment not finished yet (e.g. cash at a shop): no access
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
};

const micros = (m) => (m ? Number(m.units || 0) * 100 + Math.round(Number(m.nanos || 0) / 1e7) : null);
const time = (s) => (s ? new Date(s) : null);

/** The parts of a Play subscription we keep. */
export function subscriptionState(g) {
  const item = (g.lineItems || []).find((i) => i.productId === productId()) || (g.lineItems || [])[0] || {};
  const price = item.autoRenewingPlan?.recurringPrice;
  return {
    status: STATES[g.subscriptionState] || 'created',
    productId: item.productId || null,
    currentStart: time(g.startTime),
    currentEnd: time(item.expiryTime),
    accountId: g.externalAccountIdentifiers?.obfuscatedExternalAccountId || null,
    orderId: item.latestSuccessfulOrderId || g.latestOrderId || null,
    amountPaise: price && price.currencyCode === 'INR' ? micros(price) : null,
    acknowledged: g.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    live: !g.testPurchase,
    linkedPurchaseToken: g.linkedPurchaseToken || null,
  };
}

/** ₹ (GST included) → Google's Price in micros, before tax and tax. GST: admin console › Settings › Payments. */
export function taxSplit(amountPaise) {
  const gst = Number(settings.get('payments')?.gstPercent) || 0;
  const preTax = Math.round(amountPaise / (1 + gst / 100));
  const m = (paise) => ({ priceMicros: String(paise * 10_000), currency: 'INR' });
  return { preTax: m(preTax), tax: m(amountPaise - preTax) };
}

/**
 * Report a Razorpay payment made by someone who picked Razorpay on Play's choice screen (within 24 hours of it).
 * The first payment carries Play's token; later monthly payments point at the first one's id.
 */
export function reportExternal({ transactionId, amountPaise, time: at, token, initialTransactionId }) {
  const { preTax, tax } = taxSplit(amountPaise);
  return call('POST', `/externalTransactions?externalTransactionId=${enc(transactionId)}`, {
    originalPreTaxAmount: preTax, originalTaxAmount: tax,
    transactionTime: (at || new Date()).toISOString(),
    userTaxAddress: { regionCode: 'IN' },
    recurringTransaction: {
      ...(initialTransactionId ? { initialExternalTransactionId: initialTransactionId } : { externalTransactionToken: token }),
      externalSubscription: { subscriptionType: 'RECURRING' },
    },
  });
}

/** Play's real-time notification, out of a Pub/Sub push body. → { messageId, token, type } (token null for a test). */
export function readNotification(body) {
  const m = body?.message;
  if (!m?.data) return null;
  let n;
  try { n = JSON.parse(Buffer.from(m.data, 'base64').toString('utf8')); } catch { return null; }
  if (n.packageName && n.packageName !== packageName()) return { messageId: m.messageId || m.message_id, token: null, type: 'other_app' };
  const s = n.subscriptionNotification;
  return { messageId: String(m.messageId || m.message_id || ''), token: s?.purchaseToken || null, type: s ? `subscription.${s.notificationType}` : n.testNotification ? 'test' : 'other' };
}
