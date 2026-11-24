// Paid access through Razorpay, against a real PostgreSQL (TEST_DATABASE_URL; skipped without it) and a fake
// Razorpay: the paywall on the learning module, plans per price, subscribing, the payment signature, webhooks
// (signed, once each, state from Razorpay), renewals failing, cancelling, erasure, the admin numbers.
import { login, signInAll, SESSION_ENV } from './phone-login.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { startMockRest } from './mock-sarvam-rest.js';

const url = process.env.TEST_DATABASE_URL;
const KEY_SECRET = 'rzp-test-secret', HOOK_SECRET = 'hook-secret';
let server, base, pool, fake, mock, settings;

/** A fake Razorpay: plans, subscriptions (state set by the tests), cancellation. */
const rz = { plans: [], subs: new Map(), calls: [] };
function startFake() {
  let n = 0;
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      const b = body ? JSON.parse(body) : {};
      rz.calls.push({ method: req.method, path: req.url, body: b });
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (![`rzp_test_key`, `rzp_live_key`].some((k) => req.headers.authorization === `Basic ${Buffer.from(`${k}:${KEY_SECRET}`).toString('base64')}`)) return json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
      if (req.method === 'POST' && req.url === '/v1/plans') { const id = `plan_${String(++n).padStart(14, '0')}`; rz.plans.push({ id, amount: b.item.amount }); return json(200, { id }); }
      if (req.method === 'POST' && req.url === '/v1/subscriptions') { const id = `sub_${String(++n).padStart(14, '0')}`; rz.subs.set(id, { id, plan_id: b.plan_id, status: 'created', current_start: null, current_end: null, notes: b.notes }); return json(200, rz.subs.get(id)); }
      const m = /^\/v1\/subscriptions\/([^/]+)(\/cancel)?$/.exec(req.url);
      if (m && rz.subs.has(m[1])) {
        const sub = rz.subs.get(m[1]);
        if (m[2]) { if (!b.cancel_at_cycle_end) sub.status = 'cancelled'; sub.cancelled = b.cancel_at_cycle_end ? 'at_end' : 'now'; }
        return json(200, sub);
      }
      json(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}
const now = () => Math.floor(Date.now() / 1000);
const paidMonth = (id) => Object.assign(rz.subs.get(id), { status: 'active', current_start: now(), current_end: now() + 30 * 86400 });

before(async () => {
  if (!url) return;
  fake = await startFake(); mock = await startMockRest();
  Object.assign(process.env, { ...SESSION_ENV,
    SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, DATABASE_URL: url, ADMIN_PHONES: '+919800009999',
    RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET, RAZORPAY_BASE_URL: `http://127.0.0.1:${fake.address().port}`,
  });
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  settings = await import('../server/settings.js');
  ({ server } = await import('../server/index.js'));
  await signInAll();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); fake?.close(); mock?.close(); await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);

const call = async (method, path, headers = {}, body, raw) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: raw ?? (body && JSON.stringify(body)) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const sign = (paymentId, subId, secret = KEY_SECRET) => createHmac('sha256', secret).update(`${paymentId}|${subId}`).digest('hex');
let eventN = 0;
const hook = (event, subId, payment) => {
  const raw = JSON.stringify({ entity: 'event', event, contains: ['subscription'], payload: { subscription: { entity: { id: subId, status: 'whatever' } }, ...(payment ? { payment: { entity: payment } } : {}) }, created_at: now() });
  return { raw, headers: { 'x-razorpay-signature': createHmac('sha256', HOOK_SECRET).update(raw).digest('hex'), 'x-razorpay-event-id': `evt_${++eventN}` } };
};
const asha = login('+919800000011'), ravi = login('+919800000012'), admin = login('+919800009999');

t('payments off (the default): the learning module is open', async () => {
  assert.equal((await call('GET', '/api/pay/status', asha)).json.required, false);
  assert.equal((await call('POST', '/api/learn/conversations', asha, {})).status, 201);
});

t('payments on: practice needs a subscription (402), reading doesn’t', async () => {
  await settings.set('payments', { enabled: true, priceInr: 299 }, 'test');
  const r = await call('POST', '/api/learn/conversations', asha, {});
  assert.equal(r.status, 402);
  assert.equal(r.json.error, 'payment_required');
  assert.match(r.json.reason, /₹299 a month/);
  assert.equal((await call('GET', '/api/learn/lessons', asha)).status, 200);
  assert.equal((await call('POST', '/api/learn/lessons/articles-a-an-the/start', asha)).status, 402);
  const st = (await call('GET', '/api/pay/status', asha)).json;
  assert.deepEqual([st.required, st.active, st.priceInr], [true, false, 299]);
});

let subId;
t('subscribing: one plan for the price, a subscription for the learner, reused if they tap again', async () => {
  const r = await call('POST', '/api/pay/razorpay/subscription', asha);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  subId = r.json.subscriptionId;
  assert.deepEqual([r.json.keyId, r.json.priceInr, r.json.contact], ['rzp_test_key', 299, '+919800000011']);
  assert.equal(rz.plans.length, 1);
  assert.equal(rz.plans[0].amount, 29900, 'in paise');
  assert.equal(rz.subs.get(subId).notes.user_id.length, 36);
  assert.equal((await call('POST', '/api/pay/razorpay/subscription', asha)).json.subscriptionId, subId, 'reused');
  assert.equal(rz.plans.length, 1, 'no second plan');
});

t('the payment must carry Razorpay’s signature for this learner’s own subscription', async () => {
  paidMonth(subId);
  const bad = await call('POST', '/api/pay/razorpay/verify', asha, { paymentId: 'pay_1', subscriptionId: subId, signature: sign('pay_1', subId, 'wrong') });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'payment_not_verified');
  assert.equal((await call('POST', '/api/pay/razorpay/verify', ravi, { paymentId: 'pay_1', subscriptionId: subId, signature: sign('pay_1', subId) })).status, 404, 'not Ravi’s');
  const ok = await call('POST', '/api/pay/razorpay/verify', asha, { paymentId: 'pay_1', subscriptionId: subId, signature: sign('pay_1', subId) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.active, true);
  assert.equal(ok.json.status, 'active', 'the state comes from Razorpay');
  assert.ok(Date.parse(ok.json.paidUntil) > Date.now() + 29 * 86400_000);
  assert.equal((await call('POST', '/api/learn/conversations', asha, {})).status, 201, 'practice is open');
  assert.equal((await call('POST', '/api/learn/conversations', ravi, {})).status, 402, 'Ravi still hasn’t paid');
  assert.equal((await call('POST', '/api/pay/razorpay/subscription', asha)).status, 409, 'already subscribed');
});

t('webhooks: a bad signature is refused; each event counts once; the payment is recorded', async () => {
  const fake = hook('subscription.charged', subId);
  assert.equal((await call('POST', '/api/razorpay/webhook', { ...fake.headers, 'x-razorpay-signature': 'nope' }, null, fake.raw)).status, 400);
  const h = hook('subscription.charged', subId, { id: 'pay_2', amount: 29900, status: 'captured' });
  assert.equal((await call('POST', '/api/razorpay/webhook', h.headers, null, h.raw)).status, 200);
  assert.equal((await call('POST', '/api/razorpay/webhook', h.headers, null, h.raw)).json.duplicate, true);
  const p = (await pool.query(`select amount_paise, status from payments where provider_payment_id = 'pay_2'`)).rows;
  assert.deepEqual(p, [{ amount_paise: 29900, status: 'captured' }]);
});

t('a failing renewal keeps access while Razorpay retries; when it stops, access ends with the paid month', async () => {
  Object.assign(rz.subs.get(subId), { status: 'pending' });
  let h = hook('subscription.pending', subId);
  await call('POST', '/api/razorpay/webhook', h.headers, null, h.raw);
  assert.equal((await call('GET', '/api/pay/status', asha)).json.active, true, 'pending: still open');
  Object.assign(rz.subs.get(subId), { status: 'halted', current_end: now() - 60 });
  h = hook('subscription.halted', subId);
  await call('POST', '/api/razorpay/webhook', h.headers, null, h.raw);
  const st = (await call('GET', '/api/pay/status', asha)).json;
  assert.deepEqual([st.active, st.status], [false, 'halted']);
  assert.equal((await call('POST', '/api/learn/conversations', asha, {})).status, 402);
  paidMonth(subId);
  h = hook('subscription.activated', subId);
  await call('POST', '/api/razorpay/webhook', h.headers, null, h.raw);
  assert.equal((await call('GET', '/api/pay/status', asha)).json.active, true, 'back after they fix the payment');
});

t('cancelling stops renewal at the end of the paid month', async () => {
  const r = await call('POST', '/api/pay/cancel', asha);
  assert.equal(r.status, 200);
  assert.equal(rz.subs.get(subId).cancelled, 'at_end');
  assert.deepEqual([r.json.active, r.json.cancelAtEnd], [true, true]);
});

t('a new price makes a new plan', async () => {
  await settings.set('payments', { enabled: true, priceInr: 399 }, 'test');
  assert.equal((await call('POST', '/api/pay/razorpay/subscription', ravi)).json.priceInr, 399);
  assert.equal(rz.plans.length, 2);
  assert.equal(rz.plans[1].amount, 39900);
});

t('the admin dashboard shows subscribers and this month’s revenue', async () => {
  const o = (await call('GET', '/api/admin/overview', admin)).json;
  assert.equal(o.payments.activeSubscribers, 1);
  assert.equal(o.payments.revenueThisMonthPaise, 29900);
  assert.equal(o.payments.required, true);
});

t('switching from test keys to live keys: test plans and subscriptions are left behind', async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_live_key';
  try {
    const st = (await call('GET', '/api/pay/status', asha)).json;
    assert.deepEqual([st.active, st.status], [false, null]); // her test-mode subscription doesn't count in live mode
    const plans = rz.plans.length;
    const r = await call('POST', '/api/pay/razorpay/subscription', ravi);
    assert.equal(r.json.keyId, 'rzp_live_key');
    assert.equal(rz.plans.length, plans + 1); // a live plan, not the test one
    const o = (await call('GET', '/api/admin/overview', admin)).json;
    assert.deepEqual([o.payments.activeSubscribers, o.payments.revenueThisMonthPaise, o.payments.testMode], [0, 0, false]);
  } finally { process.env.RAZORPAY_KEY_ID = 'rzp_test_key'; }
  assert.equal((await call('GET', '/api/pay/status', asha)).json.active, true);
  assert.equal((await call('GET', '/api/admin/overview', admin)).json.payments.testMode, true);
});

t('erasing an account cancels its subscription now and keeps the payment record without the person', async () => {
  assert.equal((await call('DELETE', '/api/me', asha)).status, 200);
  assert.equal(rz.subs.get(subId).cancelled, 'now');
  const p = (await pool.query(`select user_id from payments where provider_payment_id = 'pay_2'`)).rows[0];
  assert.equal(p.user_id, null);
  await settings.reset('payments', 'test');
});
