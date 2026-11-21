// Paid access to the learning module: ₹299/month (the price is an admin setting), through Razorpay now; Google
// Play billing will sit beside it (Play's "user choice billing" for India) before the Play release (docs/PAYMENTS.md).
//
//   GET  /api/pay/status                   (signed in) → { required, active, status, paidUntil, priceInr, provider, cancelAtEnd }
//   POST /api/pay/razorpay/subscription    (signed in) → { subscriptionId, keyId, priceInr, name, description, contact }
//   POST /api/pay/razorpay/verify          (signed in) { paymentId, subscriptionId, signature } → status
//   POST /api/pay/cancel                   (signed in) → status (stops at the end of the paid month)
//   POST /api/razorpay/webhook             Razorpay's events (signed; each event once)
//
// Access: an active (or just-authorised) subscription, or one that ended but whose paid month isn't over. While a
// renewal is being retried ("pending"), access continues. The server, not the app, decides: payment signatures
// are checked, and the subscription's state always comes from Razorpay itself.
import { pool } from './db/pool.js';
import * as settings from './settings.js';
import * as rzp from './razorpay.js';
import * as accounts from './accounts.js';
import { loginEnabled } from './auth.js';
import { production } from './guard.js';
import * as store from './store.js';
import { readBody, readJson, send, fail } from './http.js';

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;

const OPEN = ['active', 'authenticated', 'pending'];
const ENDED = ['cancelled', 'halted', 'completed', 'expired', 'paused'];

/** Does this learner have paid access right now? → the subscription that gives it, or null */
export async function access(userId, now = new Date()) {
  if (!pool || !userId) return null;
  const subs = await q(`select * from subscriptions where user_id = $1 and (provider <> 'razorpay' or live = $2) order by created_at desc limit 10`, [userId, rzp.live()]);
  return subs.find((s) => OPEN.includes(s.status) || (ENDED.includes(s.status) && s.current_end && s.current_end > now)) || null;
}

export const required = () => !!settings.get('payments').enabled;

/** Throws 402 when the learning module needs a subscription this learner doesn't have. */
export async function requireAccess(userId) {
  if (!required()) return;
  if (await access(userId)) return;
  throw fail(402, 'payment_required', { reason: `Start learning with Sakhi for ₹${settings.get('payments').priceInr} a month.`, priceInr: settings.get('payments').priceInr });
}

/** The Razorpay plan for the current price (made on first use; a new price makes a new plan). */
async function planFor(priceInr) {
  const p = await one(`select provider_plan_id from payment_plans where provider = 'razorpay' and price_inr = $1 and live = $2 order by id desc limit 1`, [priceInr, rzp.live()]);
  if (p) return p.provider_plan_id;
  const id = await rzp.createPlan(priceInr);
  await pool.query(`insert into payment_plans (provider, price_inr, provider_plan_id, live) values ('razorpay', $1, $2, $3) on conflict do nothing`, [priceInr, id, rzp.live()]);
  return id;
}

async function status(userId) {
  const s = await access(userId);
  const latest = s || (await one(`select * from subscriptions where user_id = $1 and (provider <> 'razorpay' or live = $2) order by created_at desc limit 1`, [userId, rzp.live()]));
  return {
    required: required(), active: !!s, priceInr: settings.get('payments').priceInr,
    status: latest?.status || null, provider: latest?.provider || null,
    paidUntil: (s?.current_end || null) && s.current_end.toISOString(),
    cancelAtEnd: !!s?.cancel_requested_at,
  };
}

/** Store Razorpay's view of a subscription (fetched from Razorpay, so the order events arrive in can't mislead us). */
async function refresh(providerId) {
  const ours = await one(`select live from subscriptions where provider = 'razorpay' and provider_subscription_id = $1`, [providerId]);
  if (!ours || ours.live !== rzp.live()) return null;
  const st = rzp.subscriptionState(await rzp.fetchSubscription(providerId));
  return one(`update subscriptions set status = $2, current_start = coalesce($3, current_start), current_end = coalesce($4, current_end), updated_at = now()
      where provider_subscription_id = $1 returning *`, [providerId, st.status, st.currentStart, st.currentEnd]);
}

async function startRazorpay(user) {
  if (!rzp.configured()) throw fail(503, 'payments_unavailable', { reason: 'Payments aren’t available just now. Please try again later.' });
  if (await access(user.id)) throw fail(409, 'already_subscribed', { reason: 'You’re already subscribed.' });
  const priceInr = settings.get('payments').priceInr;
  const planId = await planFor(priceInr);
  // A checkout they didn't finish in the last day is reused, so tapping again doesn't pile up subscriptions.
  let s = await one(`select * from subscriptions where user_id = $1 and provider = 'razorpay' and status = 'created' and provider_plan_id = $2
      and created_at > now() - interval '1 day' order by created_at desc limit 1`, [user.id, planId]);
  if (!s) {
    const r = await rzp.createSubscription({ planId, userId: user.id });
    s = await one(`insert into subscriptions (user_id, provider, provider_subscription_id, provider_plan_id, price_inr, status, live) values ($1, 'razorpay', $2, $3, $4, $5, $6) returning *`,
      [user.id, r.id, planId, priceInr, r.status || 'created', rzp.live()]);
  }
  return { subscriptionId: s.provider_subscription_id, keyId: rzp.keyId(), priceInr, name: 'Adam', description: `Learning with Sakhi · ₹${priceInr}/month`, contact: user.phone || null };
}

async function verifyRazorpay(user, b) {
  // The subscription must be one we created for this learner; its id comes from our records, not from the app.
  const s = await one(`select * from subscriptions where provider = 'razorpay' and provider_subscription_id = $1 and user_id = $2 and live = $3`, [String(b.subscriptionId || ''), user.id, rzp.live()]);
  if (!s) throw fail(404, 'subscription not found');
  if (!rzp.paymentSignatureOk({ paymentId: b.paymentId, subscriptionId: s.provider_subscription_id, signature: b.signature })) {
    console.warn(`[pay] bad payment signature for ${s.provider_subscription_id}`);
    throw fail(400, 'payment_not_verified', { reason: 'We couldn’t confirm that payment. If money was taken, it will be refunded automatically; please contact us.' });
  }
  await pool.query(`insert into payments (user_id, subscription_id, provider, provider_payment_id, status, live) values ($1, $2, 'razorpay', $3, 'authorized', $4)
      on conflict (provider_payment_id) do nothing`, [user.id, s.id, b.paymentId, s.live]);
  await refresh(s.provider_subscription_id);
  return status(user.id);
}

async function cancel(user) {
  const s = await access(user.id);
  if (!s) throw fail(404, 'no active subscription');
  if (s.provider === 'razorpay' && OPEN.includes(s.status)) {
    await rzp.cancelSubscription(s.provider_subscription_id, { atCycleEnd: true });
    await pool.query('update subscriptions set cancel_requested_at = now(), updated_at = now() where id = $1', [s.id]);
    await refresh(s.provider_subscription_id).catch(() => {});
  }
  return status(user.id);
}

/** Razorpay's webhook: signed, each event handled once, state taken from Razorpay. */
async function webhook(req, res) {
  const raw = (await readBody(req, 256 * 1024)).toString('utf8');
  if (!rzp.webhookSignatureOk(raw, req.headers['x-razorpay-signature'])) { console.warn('[pay] webhook with a bad signature'); throw fail(400, 'bad signature'); }
  let e;
  try { e = JSON.parse(raw); } catch { throw fail(400, 'not JSON'); }
  const eventId = String(req.headers['x-razorpay-event-id'] || `${e.event}:${e.created_at}:${e.payload?.subscription?.entity?.id || e.payload?.payment?.entity?.id || ''}`);
  const subId = e.payload?.subscription?.entity?.id || null;
  const { rowCount } = await pool.query(`insert into payment_events (event_id, provider, event, subject_id) values ($1, 'razorpay', $2, $3) on conflict do nothing`, [eventId, e.event, subId]);
  if (!rowCount) return send(res, 200, { ok: true, duplicate: true });
  if (subId && String(e.event).startsWith('subscription.')) {
    const s = await refresh(subId);
    const p = e.payload?.payment?.entity;
    if (s && p?.id) {
      await pool.query(`insert into payments (user_id, subscription_id, provider, provider_payment_id, amount_paise, status, live) values ($1, $2, 'razorpay', $3, $4, $5, $6)
          on conflict (provider_payment_id) do update set amount_paise = excluded.amount_paise, status = excluded.status`,
      [s.user_id, s.id, p.id, Number.isFinite(p.amount) ? p.amount : null, p.status || null, s.live]);
    }
    if (!s) console.warn(`[pay] webhook for a subscription we don't know (or from the other mode, test/live): ${subId}`);
  }
  send(res, 200, { ok: true });
}

/** Before an account is erased: stop its Razorpay subscriptions now (no more charges). */
export async function cancelAllFor(userId) {
  if (!pool || !rzp.configured()) return;
  for (const s of await q(`select * from subscriptions where user_id = $1 and provider = 'razorpay' and status = any($2) and live = $3`, [userId, [...OPEN, 'created'], rzp.live()])) {
    await rzp.cancelSubscription(s.provider_subscription_id, { atCycleEnd: false }).catch((e) => console.warn(`[pay] cancel on erase failed: ${e.message}`));
  }
}

/** Handle /api/pay/* and /api/razorpay/webhook. → true when handled. */
export async function handlePayments(req, res, url) {
  const p = url.pathname;
  if (p === '/api/razorpay/webhook') {
    if (req.method !== 'POST') throw fail(405, 'POST only');
    if (!pool) throw fail(503, 'no database');
    await webhook(req, res);
    return true;
  }
  if (!p.startsWith('/api/pay/')) return false;
  if (!pool) throw fail(503, 'payments need the database');
  let { user } = await accounts.identify(req, { required: loginEnabled() });
  // Local development without login: the same local learner as the learning module.
  if (!user?.id && !loginEnabled() && !production) user = { id: (await store.upsertUser({ firebaseUid: 'local-dev', phone: null })).id, phone: null };
  if (!user?.id) throw fail(401, 'login required');
  res.locals = { user: user.id };
  if (req.method === 'GET' && p === '/api/pay/status') return send(res, 200, await status(user.id)), true;
  if (req.method === 'POST' && p === '/api/pay/razorpay/subscription') return send(res, 200, await startRazorpay(user)), true;
  if (req.method === 'POST' && p === '/api/pay/razorpay/verify') return send(res, 200, await verifyRazorpay(user, await readJson(req))), true;
  if (req.method === 'POST' && p === '/api/pay/cancel') return send(res, 200, await cancel(user)), true;
  throw fail(404, 'not found');
}

/** For the admin dashboard: the numbers for the mode the Razorpay key is in (test numbers while testing). */
export async function summary() {
  if (!pool) return null;
  const live = rzp.live();
  const row = await one(`select
      (select count(distinct user_id)::int from subscriptions where live = $3 and (status = any($1) or (status = any($2) and current_end > now()))) as "activeSubscribers",
      (select coalesce(sum(amount_paise), 0)::int from payments where live = $3 and status = 'captured' and created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as "revenueThisMonthPaise",
      (select count(*)::int from subscriptions where live = $3 and status = 'cancelled' and updated_at > now() - interval '30 days') as "cancelled30d"`, [OPEN, ENDED, live]);
  return { ...row, testMode: !live, configured: rzp.configured() };
}
