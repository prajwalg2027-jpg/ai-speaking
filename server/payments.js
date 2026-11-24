// Paid access to the learning module: ₹299/month (the price is an admin setting), through Razorpay or Google Play
// billing. On Play builds, Play's "user choice billing" (India) lets the learner pick Play or Razorpay
// (docs/PAYMENTS.md).
//
//   GET  /api/pay/status                   (signed in) → { required, active, status, paidUntil, priceInr, provider, cancelAtEnd, play }
//   POST /api/pay/razorpay/subscription    (signed in) { playExternalToken? } → { subscriptionId, keyId, priceInr, name, description, contact }
//   POST /api/pay/razorpay/verify          (signed in) { paymentId, subscriptionId, signature } → status
//   POST /api/pay/play/verify              (signed in) { purchaseToken } → status
//   POST /api/pay/cancel                   (signed in) → status (stops at the end of the paid month)
//   POST /api/razorpay/webhook             Razorpay's events (signed; each event once)
//   POST /api/play/rtdn?token=…            Google Play's real-time notifications, pushed by Pub/Sub (secret in the URL)
//
// Access: an active (or just-authorised) subscription, or one that ended but whose paid month isn't over. While a
// renewal is being retried ("pending"), access continues. The server, not the app, decides: payment signatures
// are checked, and the subscription's state always comes from Razorpay itself.
import { pool } from './db/pool.js';
import * as settings from './settings.js';
import * as rzp from './razorpay.js';
import * as play from './play.js';
import * as accounts from './accounts.js';
import { loginEnabled } from './auth.js';
import { production } from './guard.js';
import * as store from './store.js';
import { readBody, readJson, send, fail } from './http.js';
import { timingSafeEqual } from 'node:crypto';

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
    // Play builds offer Google Play billing (and, through it, Razorpay). The purchase carries the learner's id so the
    // server can tell whose it is (a random id, not personal data).
    play: play.configured() ? { productId: play.productId(), accountId: userId } : null,
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

async function startRazorpay(user, b = {}) {
  // From Play's choice screen (they picked Razorpay): Play's token, for reporting the payments to Google.
  const playToken = typeof b.playExternalToken === 'string' && b.playExternalToken.length < 2048 ? b.playExternalToken : null;
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
  if (playToken) await pool.query('update subscriptions set play_external_token = $2 where id = $1', [s.id, playToken]);
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
  await reportToPlay(s.id);
  return status(user.id);
}

/**
 * User choice billing: each Razorpay payment of a subscription that started on Play's choice screen is reported to
 * Google within 24 hours, the first with Play's token, later ones pointing at the first. Unreported ones are tried
 * again whenever another payment or webhook for the subscription comes in. Never throws.
 */
async function reportToPlay(subscriptionRowId) {
  try {
    if (!play.configured()) return;
    const s = await one('select id, price_inr, play_external_token from subscriptions where id = $1', [subscriptionRowId]);
    if (!s?.play_external_token) return;
    const list = await q(`select id, provider_payment_id, amount_paise, created_at, play_reported_at from payments
        where subscription_id = $1 and provider = 'razorpay' and coalesce(status, '') not in ('failed', 'refunded') order by created_at, id`, [s.id]);
    const first = list[0];
    for (const p of list) {
      if (p.play_reported_at) continue;
      if (p !== first && !first.play_reported_at) break; // the first payment has to be reported before the others
      try {
        await play.reportExternal({ transactionId: p.provider_payment_id, amountPaise: p.amount_paise ?? s.price_inr * 100, time: p.created_at,
          token: s.play_external_token, initialTransactionId: p === first ? null : first.provider_payment_id });
      } catch (e) { if (e.error !== 'already_exists') throw e; }
      await pool.query('update payments set play_reported_at = now() where id = $1', [p.id]);
      p.play_reported_at = new Date();
    }
  } catch (e) { console.warn(`[pay] reporting to Google Play failed (tried again with the next payment): ${e.message}`); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Store Google's view of a Play subscription for this learner: its state, its latest payment, acknowledged. */
async function savePlay(token, st, userId) {
  const s = await one(`insert into subscriptions (user_id, provider, provider_subscription_id, provider_plan_id, price_inr, status, current_start, current_end, cancel_requested_at, live)
      values ($1, 'play', $2, $3, $4, $5, $6, $7, case when $8 then now() end, $9)
      on conflict (provider_subscription_id) do update set status = excluded.status, current_start = coalesce(excluded.current_start, subscriptions.current_start),
        current_end = coalesce(excluded.current_end, subscriptions.current_end),
        cancel_requested_at = case when $8 then coalesce(subscriptions.cancel_requested_at, now()) end, updated_at = now()
      where subscriptions.user_id = excluded.user_id and subscriptions.provider = 'play'
      returning *`,
  [userId, token, st.productId, st.amountPaise ? Math.round(st.amountPaise / 100) : settings.get('payments').priceInr, st.status, st.currentStart, st.currentEnd, st.status === 'cancelled', st.live]);
  if (!s) return null; // the token is on someone else's subscription
  // A resubscription or plan change replaces the old purchase.
  if (st.linkedPurchaseToken) await pool.query(`update subscriptions set status = 'expired', updated_at = now() where provider = 'play' and provider_subscription_id = $1 and user_id = $2 and status <> 'expired'`, [st.linkedPurchaseToken, userId]);
  if (st.orderId && s.status !== 'created') {
    await pool.query(`insert into payments (user_id, subscription_id, provider, provider_payment_id, amount_paise, status, live) values ($1, $2, 'play', $3, $4, 'captured', $5)
        on conflict (provider_payment_id) do nothing`, [userId, s.id, st.orderId, st.amountPaise, st.live]);
  }
  if (!st.acknowledged && s.status !== 'created') {
    await play.acknowledge(token).catch((e) => console.warn(`[pay] Play acknowledge failed (tried again on the next notification): ${e.message}`));
  }
  return s;
}

/** The app bought a Play subscription: Google confirms it, and that it was bought for this learner. */
async function verifyPlay(user, b) {
  if (!play.configured()) throw fail(503, 'payments_unavailable', { reason: 'Payments aren’t available just now. Please try again later.' });
  const token = typeof b.purchaseToken === 'string' ? b.purchaseToken : '';
  if (!token || token.length > 2048) throw fail(400, 'purchaseToken needed');
  let st;
  try { st = play.subscriptionState(await play.fetchSubscription(token)); }
  catch (e) {
    if (e.error !== 'purchase_not_found') throw e;
    console.warn(`[pay] Play doesn't know a purchase token sent by ${user.id}`);
    throw fail(400, 'payment_not_verified', { reason: NOT_VERIFIED });
  }
  if (st.productId !== play.productId() || st.accountId !== user.id) {
    console.warn(`[pay] Play purchase for ${st.productId} / account ${st.accountId} sent by ${user.id}`);
    throw fail(400, 'payment_not_verified', { reason: NOT_VERIFIED });
  }
  if (!(await savePlay(token, st, user.id))) throw fail(409, 'payment_not_verified', { reason: NOT_VERIFIED });
  return status(user.id);
}
const NOT_VERIFIED = 'We couldn’t confirm that payment. If money was taken, it will be refunded automatically; please contact us.';

/** Fetch a Play subscription's state from Google again (a notification, a cancel). → the row, or null */
async function refreshPlay(token) {
  const st = play.subscriptionState(await play.fetchSubscription(token));
  const ours = await one(`select user_id from subscriptions where provider = 'play' and provider_subscription_id = $1`, [token]);
  // Bought, but the app never got to tell us (closed, offline): the purchase names the learner.
  const userId = ours?.user_id || (UUID.test(st.accountId || '') && (await one('select id from users where id = $1', [st.accountId]))?.id);
  if (!userId || st.productId !== play.productId()) return null;
  return savePlay(token, st, userId);
}

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/** Google Play's real-time notifications (Pub/Sub push): only a hint; the state is always fetched from Google. */
async function rtdn(req, res, url) {
  if (!play.configured() || !play.rtdnToken() || !same(url.searchParams.get('token') || '', play.rtdnToken())) throw fail(403, 'forbidden');
  const n = play.readNotification(await readJson(req));
  if (!n?.messageId) return send(res, 200, { ok: true, ignored: true }); // not ours to retry
  const seen = await one(`select 1 as x from payment_events where event_id = $1`, [`play:${n.messageId}`]);
  if (seen) return send(res, 200, { ok: true, duplicate: true });
  if (n.token) {
    try {
      const s = await refreshPlay(n.token);
      if (!s) console.warn(`[pay] Play notification for a purchase we can't match to a learner (${n.type})`);
      else await reportToPlay(s.id);
    } catch (e) {
      if (e.error !== 'purchase_not_found') throw e; // 5xx: Pub/Sub sends it again later
      console.warn(`[pay] Play notification for a purchase Google doesn't know: ${e.message}`);
    }
  }
  // Recorded once handled, so a failure above is retried by Pub/Sub.
  await pool.query(`insert into payment_events (event_id, provider, event, subject_id) values ($1, 'play', $2, $3) on conflict do nothing`, [`play:${n.messageId}`, n.type, n.token ? n.token.slice(0, 40) : null]);
  send(res, 200, { ok: true });
}

async function cancel(user) {
  const s = await access(user.id);
  if (!s) throw fail(404, 'no active subscription');
  if (s.provider === 'razorpay' && OPEN.includes(s.status)) {
    await rzp.cancelSubscription(s.provider_subscription_id, { atCycleEnd: true });
    await pool.query('update subscriptions set cancel_requested_at = now(), updated_at = now() where id = $1', [s.id]);
    await refresh(s.provider_subscription_id).catch(() => {});
  }
  if (s.provider === 'play' && OPEN.includes(s.status)) {
    await play.cancel(s.provider_subscription_id);
    await pool.query('update subscriptions set cancel_requested_at = now(), updated_at = now() where id = $1', [s.id]);
    await refreshPlay(s.provider_subscription_id).catch(() => {});
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
    if (s) await reportToPlay(s.id);
    if (!s) console.warn(`[pay] webhook for a subscription we don't know (or from the other mode, test/live): ${subId}`);
  }
  send(res, 200, { ok: true });
}

/** Before an account is erased: stop its subscriptions (no more charges; Razorpay's now, Play's at the end of the month). */
export async function cancelAllFor(userId) {
  if (!pool) return;
  if (play.configured()) {
    for (const s of await q(`select * from subscriptions where user_id = $1 and provider = 'play' and status = any($2)`, [userId, OPEN])) {
      await play.cancel(s.provider_subscription_id).catch((e) => console.warn(`[pay] Play cancel on erase failed: ${e.message}`));
    }
  }
  if (!rzp.configured()) return;
  for (const s of await q(`select * from subscriptions where user_id = $1 and provider = 'razorpay' and status = any($2) and live = $3`, [userId, [...OPEN, 'created'], rzp.live()])) {
    await rzp.cancelSubscription(s.provider_subscription_id, { atCycleEnd: false }).catch((e) => console.warn(`[pay] cancel on erase failed: ${e.message}`));
  }
}

/** Handle /api/pay/*, /api/razorpay/webhook and /api/play/rtdn. → true when handled. */
export async function handlePayments(req, res, url) {
  const p = url.pathname;
  if (p === '/api/play/rtdn') {
    if (req.method !== 'POST') throw fail(405, 'POST only');
    if (!pool) throw fail(503, 'no database');
    await rtdn(req, res, url);
    return true;
  }
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
  if (req.method === 'POST' && p === '/api/pay/razorpay/subscription') return send(res, 200, await startRazorpay(user, await readJson(req).catch(() => ({})))), true;
  if (req.method === 'POST' && p === '/api/pay/razorpay/verify') return send(res, 200, await verifyRazorpay(user, await readJson(req))), true;
  if (req.method === 'POST' && p === '/api/pay/play/verify') return send(res, 200, await verifyPlay(user, await readJson(req))), true;
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
