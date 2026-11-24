// Google Play billing beside Razorpay, against a real PostgreSQL (TEST_DATABASE_URL; skipped without it), a fake
// Google Play Developer API and a fake Razorpay: Play purchases checked with Google and tied to the learner,
// acknowledged, renewals and holds from real-time notifications, cancelling, and user choice billing (a learner
// picks Razorpay on Play's screen: each Razorpay payment is reported to Google).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import { startMockRest } from './mock-sarvam-rest.js';

const url = process.env.TEST_DATABASE_URL;
const PROJECT = 'sakhi-test', KEY_SECRET = 'rzp-test-secret', HOOK_SECRET = 'hook-secret';
const PKG = 'in.adamspeaks.test', PRODUCT = 'learning_monthly', PLAY_TOKEN = 'play-access-token', RTDN = 'rtdn-secret';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let server, base, pool, fakePlay, fakeRzp, mock, settings;

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

/** A fake Google Play Developer API: purchases (set by the tests), acknowledge, cancel, external transactions. */
const gp = { subs: new Map(), acks: [], cancels: [], reports: [] };
const playHandler = async (req, res) => {
  const b = await readBody(req);
  if (req.headers.authorization !== `Bearer ${PLAY_TOKEN}`) return json(res, 401, { error: { message: 'no' } });
  const u = new URL(req.url, 'http://x');
  const prefix = `/androidpublisher/v3/applications/${PKG}`;
  if (!u.pathname.startsWith(prefix)) return json(res, 404, {});
  const p = u.pathname.slice(prefix.length);
  let m = /^\/purchases\/subscriptionsv2\/tokens\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && m) return gp.subs.has(m[1]) ? json(res, 200, gp.subs.get(m[1])) : json(res, 400, { error: { message: 'Invalid Value' } });
  m = /^\/purchases\/subscriptions\/([^/]+)\/tokens\/([^/:]+):(acknowledge|cancel)$/.exec(p);
  if (req.method === 'POST' && m && gp.subs.has(m[2])) {
    const s = gp.subs.get(m[2]);
    if (m[3] === 'acknowledge') { gp.acks.push(m[2]); s.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'; }
    else { gp.cancels.push(m[2]); s.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED'; }
    return json(res, 200, {});
  }
  if (req.method === 'POST' && p === '/externalTransactions') {
    const id = u.searchParams.get('externalTransactionId');
    if (gp.reports.some((r) => r.id === id)) return json(res, 409, { error: { message: 'exists' } });
    gp.reports.push({ id, ...b });
    return json(res, 200, { externalTransactionId: id });
  }
  json(res, 404, {});
};

/** A fake Razorpay (enough for one subscription and its payments). */
const rz = { subs: new Map() };
let rzN = 0;
const rzpHandler = async (req, res) => {
  const b = await readBody(req);
  if (req.method === 'POST' && req.url === '/v1/plans') return json(res, 200, { id: `plan_${++rzN}` });
  if (req.method === 'POST' && req.url === '/v1/subscriptions') { const id = `sub_${++rzN}`; rz.subs.set(id, { id, plan_id: b.plan_id, status: 'created' }); return json(res, 200, rz.subs.get(id)); }
  const m = /^\/v1\/subscriptions\/([^/]+)(\/cancel)?$/.exec(req.url);
  if (m && rz.subs.has(m[1])) return json(res, 200, rz.subs.get(m[1]));
  json(res, 404, { error: { description: 'not found' } });
};

const now = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString();
/** A Play subscription as Google returns it. */
const playSub = ({ account, state = 'SUBSCRIPTION_STATE_ACTIVE', order = 'GPA.1111-2222-3333-44444', end = now() + 30 * 86400, product = PRODUCT, test: testPurchase = false }) => ({
  kind: 'androidpublisher#subscriptionPurchaseV2', regionCode: 'IN', startTime: iso(now()), subscriptionState: state,
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: account ? { obfuscatedExternalAccountId: account } : undefined,
  lineItems: [{ productId: product, expiryTime: iso(end), latestSuccessfulOrderId: order, autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { currencyCode: 'INR', units: '299' } } }],
  ...(testPurchase ? { testPurchase: {} } : {}),
});

before(async () => {
  if (!url) return;
  fakePlay = await listen(playHandler); fakeRzp = await listen(rzpHandler); mock = await startMockRest();
  Object.assign(process.env, {
    SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, DATABASE_URL: url, FIREBASE_PROJECT_ID: PROJECT, ADMIN_PHONES: '+919800009999',
    RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET, RAZORPAY_BASE_URL: `http://127.0.0.1:${fakeRzp.address().port}`,
    PLAY_PACKAGE_NAME: PKG, PLAY_PRODUCT_ID: PRODUCT, PLAY_ACCESS_TOKEN: PLAY_TOKEN, PLAY_RTDN_TOKEN: RTDN, PLAY_BASE_URL: `http://127.0.0.1:${fakePlay.address().port}`,
  });
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  (await import('../server/auth.js')).setKeyResolver(async () => ({ k1: publicKey }));
  settings = await import('../server/settings.js');
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await settings.set('payments', { enabled: true, priceInr: 299 }, 'test');
});
after(async () => { if (settings) await settings.reset('payments', 'test'); server?.close(); fakePlay?.close(); fakeRzp?.close(); mock?.close(); await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);

const iat = now();
function login(uid, phone) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: uid, iat, exp: iat + 3600, auth_time: iat, phone_number: phone, firebase: { sign_in_provider: 'phone' } })}`;
  return { authorization: `Bearer ${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}` };
}
const call = async (method, path, headers = {}, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
let msgN = 0;
const notify = (token, type = 2, messageId = `m${++msgN}`) => call('POST', `/api/play/rtdn?token=${RTDN}`, {}, {
  message: { messageId, data: Buffer.from(JSON.stringify({ version: '1.0', packageName: PKG, eventTimeMillis: String(Date.now()), subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token } })).toString('base64') },
  subscription: 'projects/x/subscriptions/play',
});
const asha = login('u-asha', '+919800000021'), ravi = login('u-ravi', '+919800000022'), meera = login('u-meera', '+919800000023');
const ids = {};
const idOf = async (who, h) => (ids[who] ??= (await call('GET', '/api/me', h)).json.id);
const active = async (h) => (await call('GET', '/api/pay/status', h)).json;

t('the status offers Play billing, with the learner’s id for the purchase', async () => {
  const st = await active(asha);
  assert.deepEqual(st.play, { productId: PRODUCT, accountId: await idOf('asha', asha) });
  assert.equal(st.active, false);
});

t('a Play purchase counts only when Google knows it, for this product and this learner', async () => {
  const a = await idOf('asha', asha);
  assert.equal((await call('POST', '/api/pay/play/verify', asha, { purchaseToken: 'made-up' })).json.error, 'payment_not_verified');
  gp.subs.set('tok-other-product', playSub({ account: a, product: 'something_else' }));
  assert.equal((await call('POST', '/api/pay/play/verify', asha, { purchaseToken: 'tok-other-product' })).status, 400);
  gp.subs.set('tok-asha', playSub({ account: a }));
  assert.equal((await call('POST', '/api/pay/play/verify', ravi, { purchaseToken: 'tok-asha' })).json.error, 'payment_not_verified', 'bought for Asha, not Ravi');
  assert.equal((await call('POST', '/api/learn/conversations', asha, {})).status, 402);
  const ok = await call('POST', '/api/pay/play/verify', asha, { purchaseToken: 'tok-asha' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.active, ok.json.status, ok.json.provider], [true, 'active', 'play']);
  assert.ok(Date.parse(ok.json.paidUntil) > Date.now() + 29 * 86400_000);
  assert.deepEqual(gp.acks, ['tok-asha'], 'acknowledged, so Google doesn’t refund it');
  assert.equal((await call('POST', '/api/learn/conversations', asha, {})).status, 201, 'practice is open');
  const p = (await pool.query(`select provider, amount_paise, status from payments where provider_payment_id = 'GPA.1111-2222-3333-44444'`)).rows;
  assert.deepEqual(p, [{ provider: 'play', amount_paise: 29900, status: 'captured' }]);
  assert.equal((await call('POST', '/api/pay/play/verify', asha, { purchaseToken: 'tok-asha' })).status, 200, 'sending it again is fine');
  assert.equal(gp.acks.length, 1, 'not acknowledged twice');
});

t('notifications: need the secret, are only a hint, count once; renewals add a payment', async () => {
  assert.equal((await call('POST', '/api/play/rtdn?token=wrong', {}, {})).status, 403);
  Object.assign(gp.subs.get('tok-asha'), { lineItems: [{ ...gp.subs.get('tok-asha').lineItems[0], latestSuccessfulOrderId: 'GPA.1111-2222-3333-44444..0', expiryTime: iso(now() + 60 * 86400) }] });
  assert.equal((await notify('tok-asha', 2, 'renew-1')).status, 200);
  assert.equal((await notify('tok-asha', 2, 'renew-1')).json.duplicate, true);
  assert.equal((await pool.query(`select count(*)::int as n from payments where provider = 'play'`)).rows[0].n, 2);
  assert.ok(Date.parse((await active(asha)).paidUntil) > Date.now() + 59 * 86400_000);
});

t('a renewal failing: grace period keeps access, on hold ends it, fixed brings it back', async () => {
  const s = gp.subs.get('tok-asha');
  s.subscriptionState = 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
  await notify('tok-asha', 6);
  assert.equal((await active(asha)).active, true);
  Object.assign(s, { subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD', lineItems: [{ ...s.lineItems[0], expiryTime: iso(now() - 60) }] });
  await notify('tok-asha', 5);
  assert.deepEqual([(await active(asha)).active, (await active(asha)).status], [false, 'halted']);
  Object.assign(s, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [{ ...s.lineItems[0], expiryTime: iso(now() + 30 * 86400) }] });
  await notify('tok-asha', 1);
  assert.equal((await active(asha)).active, true);
});

t('bought on Play but the app never told us: the notification links it to the learner', async () => {
  gp.subs.set('tok-ravi', playSub({ account: await idOf('ravi', ravi), order: 'GPA.5555' }));
  await notify('tok-ravi', 4);
  assert.deepEqual([(await active(ravi)).active, (await active(ravi)).provider], [true, 'play']);
  assert.ok(gp.acks.includes('tok-ravi'));
});

t('cancelling a Play subscription stops renewal; access lasts to the end of the month', async () => {
  const r = await call('POST', '/api/pay/cancel', asha);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(gp.cancels, ['tok-asha']);
  assert.deepEqual([r.json.active, r.json.cancelAtEnd, r.json.status], [true, true, 'cancelled']);
});

t('user choice billing: Razorpay picked on Play’s screen, each payment reported to Google', async () => {
  const start = await call('POST', '/api/pay/razorpay/subscription', meera, { playExternalToken: 'ext-token-1' });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const sub = start.json.subscriptionId;
  Object.assign(rz.subs.get(sub), { status: 'active', current_start: now(), current_end: now() + 30 * 86400 });
  const sig = createHmac('sha256', KEY_SECRET).update(`pay_m1|${sub}`).digest('hex');
  assert.equal((await call('POST', '/api/pay/razorpay/verify', meera, { paymentId: 'pay_m1', subscriptionId: sub, signature: sig })).json.active, true);
  assert.equal(gp.reports.length, 1);
  const first = gp.reports[0];
  assert.equal(first.id, 'pay_m1');
  assert.equal(first.recurringTransaction.externalTransactionToken, 'ext-token-1');
  assert.deepEqual([first.originalPreTaxAmount, first.originalTaxAmount], [{ priceMicros: '299000000', currency: 'INR' }, { priceMicros: '0', currency: 'INR' }], 'no GST (not registered)');
  assert.equal(first.userTaxAddress.regionCode, 'IN');
  // Once GST-registered, the admin sets 18% (Settings › Payments): ₹299 with 18% GST in it.
  await settings.set('payments', { enabled: true, priceInr: 299, gstPercent: 18 }, 'test');
  try { assert.deepEqual((await import('../server/play.js')).taxSplit(29900), { preTax: { priceMicros: '253390000', currency: 'INR' }, tax: { priceMicros: '45610000', currency: 'INR' } }); }
  finally { await settings.set('payments', { enabled: true, priceInr: 299 }, 'test'); }
  assert.equal(settings.get('payments').gstPercent, 0, 'saved without it: 0');
  // The next month's payment, from Razorpay's webhook: reported as a renewal of the first.
  const raw = JSON.stringify({ event: 'subscription.charged', payload: { subscription: { entity: { id: sub } }, payment: { entity: { id: 'pay_m2', amount: 29900, status: 'captured' } } }, created_at: now() });
  const hook = await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers: { 'x-razorpay-signature': createHmac('sha256', HOOK_SECRET).update(raw).digest('hex'), 'x-razorpay-event-id': 'evt_m2' }, body: raw });
  assert.equal(hook.status, 200);
  assert.equal(gp.reports.length, 2);
  assert.deepEqual(gp.reports[1].recurringTransaction, { initialExternalTransactionId: 'pay_m1', externalSubscription: { subscriptionType: 'RECURRING' } });
  const unreported = (await pool.query(`select count(*)::int as n from payments where provider = 'razorpay' and play_reported_at is null`)).rows[0].n;
  assert.equal(unreported, 0);
});

t('erasing an account cancels its Play subscription', async () => {
  assert.equal((await call('DELETE', '/api/me', ravi)).status, 200);
  assert.ok(gp.cancels.includes('tok-ravi'));
});
