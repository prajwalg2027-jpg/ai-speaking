// Phone OTP login through MSG91 and the server's own sessions, against a real PostgreSQL (TEST_DATABASE_URL;
// skipped without it) and a fake MSG91: sending, limits, wrong and reused codes, the verified number, sessions,
// sign-out, erasure, the test number, and a Firebase-era customer keeping their account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const url = process.env.TEST_DATABASE_URL;
let server, base, pool, fake, msg91Base;
const GOOD = '424242';

/** A fake MSG91 OTP widget API. mode.identifier: 'match' | 'other' | 'absent' (what verifyAccessToken says). */
const mode = { identifier: 'match' };
const tcMode = { verified: true };
const calls = [];
function startFake() {
  const sent = new Map(); let n = 0;
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      let b = {}; try { b = JSON.parse(body || '{}'); } catch { /* a form (Truecaller) */ }
      const path = req.url.replace('/api/v5/widget/', '');
      calls.push({ path, body: b, authkey: req.headers.authkey });
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const status = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/v1/token') {
        const f = new URLSearchParams(body);
        const [, phone, verifier] = String(f.get('code')).split(':');
        if (f.get('grant_type') !== 'authorization_code' || f.get('client_id') !== 'tc-client-release' || f.get('code_verifier') !== verifier) return status(403, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        return json({ access_token: `at:${phone}`, expires_in: 3600, scope: 'openid phone profile', token_type: 'Bearer' });
      }
      if (req.url === '/v1/userinfo') {
        const phone = String(req.headers.authorization).replace('Bearer at:', '');
        if (!phone || phone.startsWith('Bearer')) return status(401, { status: 40101, message: 'Unauthorized' });
        return json({ sub: '1362', given_name: 'Asha', family_name: 'Rao', phone_number: phone, phone_number_country_code: 'IN', phone_number_verified: tcMode.verified });
      }
      if (req.headers.authkey !== 'test-authkey') return json({ message: 'AuthenticationFailure', type: 'error', code: '401' });
      if (path === 'sendOtp') { const id = `req-${++n}`; sent.set(id, b.identifier); return json({ type: 'success', message: id }); }
      if (path === 'retryOtp') return sent.has(b.reqId) ? json({ type: 'success', message: 'retry sent' }) : json({ type: 'error', message: 'invalid reqId', code: 702 });
      if (path === 'verifyOtp') return b.otp === GOOD && sent.has(b.reqId) ? json({ type: 'success', message: `jwt.${b.reqId}` }) : json({ type: 'error', message: 'OTP not match', code: 703 });
      if (path === 'verifyAccessToken') {
        const reqId = String(b['access-token']).replace('jwt.', '');
        if (!sent.has(reqId)) return json({ type: 'error', message: 'invalid token', code: 706 });
        const number = mode.identifier === 'other' ? '919000000000' : sent.get(reqId);
        return json(mode.identifier === 'absent' ? { type: 'success', message: 'verified' } : { type: 'success', message: number });
      }
      json({ type: 'error', message: 'unknown' });
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

before(async () => {
  if (!url) return;
  fake = await startFake();
  msg91Base = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    DATABASE_URL: url, MSG91_AUTHKEY: 'test-authkey', MSG91_WIDGET_ID: 'widget-1', MSG91_BASE_URL: msg91Base,
    TRUECALLER_BASE_URL: msg91Base, TRUECALLER_CLIENT_IDS: 'tc-client-debug,tc-client-release',
    SESSION_SECRET: 'x'.repeat(48), MSG91_TEST_PHONE: '+919999900000', MSG91_TEST_CODE: '123456', ADMIN_PHONES: '+919800000077,+919000000001', DEMO_PHONES: '+919000000001',
  });
  delete process.env.FIREBASE_PROJECT_ID;
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); fake?.close(); await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);

let ipN = 0;
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++ipN % 250}`, ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const bearer = (token) => ({ authorization: `Bearer ${token}` });
async function signIn(phone) {
  const s = await call('POST', '/api/auth/otp/send', { phone });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const v = await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: GOOD, client: 'android' });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return v.json;
}

t('only Indian mobile numbers get a code', async () => {
  for (const phone of ['12345', '+14155550000', '5123456789', '']) {
    const r = await call('POST', '/api/auth/otp/send', { phone });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_number');
  }
});

t('sending: MSG91 is called by the server with its key, the widget and the number', async () => {
  calls.length = 0;
  const r = await call('POST', '/api/auth/otp/send', { phone: '98765 43210' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['codeLength', 'expiresInSec', 'requestId', 'resendAfterSec']);
  assert.equal(r.json.codeLength, 6);
  assert.deepEqual(calls[0], { path: 'sendOtp', body: { widgetId: 'widget-1', identifier: '919876543210' }, authkey: 'test-authkey' });
  assert.ok(!JSON.stringify(r.json).includes('req-'), 'MSG91’s request id stays on the server');
});

t('the code length follows the MSG91 widget (OTP_LENGTH)', async () => {
  process.env.OTP_LENGTH = '4';
  const r = await call('POST', '/api/auth/otp/send', { phone: '9876500099' });
  delete process.env.OTP_LENGTH;
  assert.equal(r.json.codeLength, 4);
});

t('a wrong code is refused; after 5 tries the request is locked', async () => {
  const s = await call('POST', '/api/auth/otp/send', { phone: '9876500001' });
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: '111111' });
    assert.equal(r.json.error, 'wrong_code');
  }
  const locked = await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: GOOD });
  assert.equal(locked.status, 429, 'even the right code, after 5 wrong ones');
});

let first;
t('the right code signs in: a customer and a session, and the token works on the API', async () => {
  first = await signIn('9876500002');
  assert.equal(first.user.phone, '+919876500002');
  assert.equal(first.user.created, true);
  const me = await call('GET', '/api/me', null, bearer(first.token));
  assert.equal(me.status, 200);
  assert.equal(me.json.phone, '+919876500002');
  assert.equal((await call('GET', '/api/me')).status, 401, 'no token, no entry');
});

t('a code works once', async () => {
  const s = await call('POST', '/api/auth/otp/send', { phone: '9876500003' });
  assert.equal((await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: GOOD })).status, 200);
  const again = await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: GOOD });
  assert.equal(again.status, 410);
  assert.equal(again.json.error, 'code_expired');
});

t('if MSG91 says it verified a different number, sign-in is refused', async () => {
  mode.identifier = 'other';
  const s = await call('POST', '/api/auth/otp/send', { phone: '9876500004' });
  const r = await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: GOOD });
  mode.identifier = 'match';
  assert.notEqual(r.status, 200);
  assert.equal((await pool.query(`select count(*)::int as n from users where phone = '+919876500004'`)).rows[0].n, 0);
});

t('if MSG91’s answer carries no number, the request it was sent for decides', async () => {
  mode.identifier = 'absent';
  const r = await signIn('9876500005');
  mode.identifier = 'match';
  assert.equal(r.user.phone, '+919876500005');
});

t('limits: 5 codes per number per hour', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/otp/send', { phone: '9876500006' })).status, 200);
  const r = await call('POST', '/api/auth/otp/send', { phone: '9876500006' });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'too_many_requests');
});

t('resending: not within 30 seconds; then on the chosen channel', async () => {
  const s = await call('POST', '/api/auth/otp/send', { phone: '9876500007' });
  assert.equal((await call('POST', '/api/auth/otp/resend', { requestId: s.json.requestId })).status, 429);
  await pool.query(`update otp_requests set last_sent_at = now() - interval '1 minute' where id = $1`, [s.json.requestId]);
  calls.length = 0;
  assert.equal((await call('POST', '/api/auth/otp/resend', { requestId: s.json.requestId, channel: 'voice' })).status, 200);
  assert.equal(calls[0].path, 'retryOtp');
  assert.equal(calls[0].body.retryChannel, 4);
});

t('sessions: refresh gives a new token; sign-out ends the session at once', async () => {
  const s = await signIn('9876500008');
  const r = await call('POST', '/api/auth/refresh', null, bearer(s.token));
  assert.equal(r.status, 200);
  assert.notEqual(r.json.token, s.token);
  assert.equal((await call('POST', '/api/auth/logout', null, bearer(r.json.token))).status, 200);
  assert.equal((await call('GET', '/api/me', null, bearer(r.json.token))).status, 401);
  assert.equal((await call('GET', '/api/me', null, bearer(s.token))).status, 401, 'same session, also ended');
});

t('a tampered or foreign token is refused', async () => {
  const [h, p, sig] = first.token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, phone: '+919800000077' })).toString('base64url')}.${sig}`;
  assert.equal((await call('GET', '/api/me', null, bearer(forged))).status, 401);
  assert.equal((await call('GET', '/api/me', null, bearer('abc.def.ghi'))).status, 401);
});

t('a customer from the Firebase days keeps their account when they sign in with an OTP', async () => {
  const { rows: [old] } = await pool.query(`insert into users (firebase_uid, phone) values ('firebase-abc', '+919876500009') returning id`);
  const s = await signIn('9876500009');
  assert.equal(s.user.id, old.id);
  assert.equal(s.user.created, false);
});

t('deleting the account ends its sessions and removes its OTP requests', async () => {
  const s = await signIn('9876500010');
  assert.equal((await call('DELETE', '/api/me', null, bearer(s.token))).status, 200);
  assert.equal((await call('GET', '/api/me', null, bearer(s.token))).status, 401);
  assert.equal((await pool.query(`select count(*)::int as n from otp_requests where phone = '+919876500010'`)).rows[0].n, 0);
});

t('the team’s test number signs in with its fixed code and sends no SMS', async () => {
  calls.length = 0;
  const s = await call('POST', '/api/auth/otp/send', { phone: '+91 99999 00000' });
  assert.equal(s.status, 200);
  assert.equal(calls.length, 0);
  assert.equal((await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: '654321' })).json.error, 'wrong_code');
  assert.equal((await call('POST', '/api/auth/otp/verify', { requestId: s.json.requestId, code: '123456' })).status, 200);
});

t('the admin console accepts an OTP session for an admin number, and only that', async () => {
  const admin = await signIn('9800000077');
  assert.equal((await call('GET', '/api/admin/me', null, bearer(admin.token))).json.phone, '+919800000077');
  assert.equal((await call('GET', '/api/admin/me', null, bearer(first.token))).status, 403);
  const demo = await signIn('9000000001');
  assert.equal((await call('GET', '/api/admin/me', null, bearer(demo.token))).status, 403, 'a demo number is never an admin, even if listed');
  assert.deepEqual((await call('GET', '/api/admin/config')).json, { loginRequired: true, login: 'otp', firebase: null });
});

// ---- Truecaller one-tap ----
const V = 'v'.repeat(50);
const tc = (phone, extra = {}) => call('POST', '/api/auth/truecaller', { code: `code:${phone}:${V}`, codeVerifier: V, clientId: 'tc-client-release', client: 'android', ...extra });

t('Truecaller: the verified number from Truecaller signs in, with the name', async () => {
  const r = await tc('919876511111');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.phone, '+919876511111');
  assert.equal(r.json.name, 'Asha Rao');
  assert.equal((await call('GET', '/api/me', null, bearer(r.json.token))).json.phone, '+919876511111');
});

t('Truecaller: a code with the wrong verifier, or for another app, is refused', async () => {
  const wrong = await tc('919876511112', { codeVerifier: 'w'.repeat(50) });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'truecaller_failed');
  assert.equal((await tc('919876511112', { clientId: 'someone-else' })).json.error, 'truecaller_failed');
  assert.equal((await tc('919876511112', { codeVerifier: 'short' })).json.error, 'truecaller_failed');
  assert.equal((await pool.query(`select count(*)::int as n from users where phone = '+919876511112'`)).rows[0].n, 0);
});

t('Truecaller: an unverified number, or one outside India, is refused', async () => {
  tcMode.verified = false;
  const r = await tc('919876511113');
  tcMode.verified = true;
  assert.equal(r.json.error, 'truecaller_failed');
  assert.equal((await tc('14155550000')).json.error, 'invalid_number');
});

t('Truecaller: the same customer as an SMS sign-in with that number', async () => {
  const otp = await signIn('9876511114');
  const r = await tc('919876511114');
  assert.equal(r.json.user.id, otp.user.id);
  assert.equal(r.json.user.created, false);
});
