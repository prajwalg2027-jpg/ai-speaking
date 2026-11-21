// Phone OTP login, through MSG91 (server/msg91.js), ending in one of the server's own sessions.
//
//   POST /api/auth/otp/send     { phone }                     → { requestId, codeLength, resendAfterSec, expiresInSec }
//   POST /api/auth/otp/resend   { requestId, channel? }       → { ok, resendAfterSec }   (channel: sms | voice | whatsapp)
//   POST /api/auth/otp/verify   { requestId, code, client? }  → { token, expiresAt, user: { id, phone, created } }
//   POST /api/auth/refresh      (signed in)                    → { token, expiresAt }
//   POST /api/auth/logout       (signed in)                    → { ok }
//
// The server sends and checks the code, so MSG91's key stays here, the request is tied to the number it was
// sent to, and sending can be limited: Indian mobile numbers only, a few codes per number and per address
// each hour, a daily cap on all codes (each SMS costs money), and 5 tries per code. Errors are
// { error: invalid_number | too_many_requests | wrong_code | code_expired | unavailable, reason }.
//
// The team's test number (MSG91_TEST_PHONE + MSG91_TEST_CODE, e.g. for the Play Store review) signs in with its
// fixed code and sends no SMS.
import { timingSafeEqual } from 'node:crypto';
import { pool } from './db/pool.js';
import * as msg91 from './msg91.js';
import * as sessions from './sessions.js';
import * as store from './store.js';
import { caller } from './auth.js';
import { RateLimit, clientIp } from './guard.js';
import { readJson, send, fail } from './http.js';

export const CODE_LENGTH = 6;
const EXPIRES_SEC = 600, RESEND_AFTER_SEC = 30, MAX_RESENDS = 3, MAX_ATTEMPTS = 5;
const num = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== '' ? Number(process.env[k]) : d);
const LIMITS = {
  perPhonePerHour: () => num('OTP_PER_PHONE_PER_HOUR', 5),
  perIpPerHour: () => num('OTP_PER_IP_PER_HOUR', 20),
  perDay: () => num('OTP_PER_DAY', 3000),
};
const perIp = new RateLimit(() => LIMITS.perIpPerHour(), 3600_000);

const testPhone = () => (process.env.MSG91_TEST_PHONE && /^\d{4,8}$/.test(process.env.MSG91_TEST_CODE || '') ? process.env.MSG91_TEST_PHONE : null);
export const enabled = () => sessions.enabled() && (msg91.configured() || !!testPhone());

/** "98765 43210", "+91 98765-43210", "098765 43210" → "+919876543210"; null if it isn't an Indian mobile number. */
export function indianMobile(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 && /^[6-9]/.test(d) ? `+91${d}` : null;
}

const refuse = (status, error, reason) => fail(status, error, { reason });
const REASONS = {
  invalid_number: [400, 'That number doesn’t look right. Check it and try again.'],
  too_many_requests: [429, 'Too many tries. Please wait a while and try again.'],
  wrong_code: [400, 'That code isn’t right. Check the SMS and try again.'],
  code_expired: [410, 'That code has expired. Ask for a new one.'],
  unavailable: [503, 'Sign-in isn’t available just now. Please try again in a few minutes.'],
  other: [502, 'Something went wrong. Please try again.'],
};
const refuseFor = (reason) => { const [s, r] = REASONS[reason] || REASONS.other; return refuse(s, reason in REASONS ? reason : 'other', r); };

async function sendCode(req) {
  const phone = indianMobile((await readJson(req)).phone);
  if (!phone) throw refuseFor('invalid_number');
  const ip = clientIp(req);
  if (!perIp.hit(ip)) throw refuseFor('too_many_requests');
  const { rows: [c] } = await pool.query(`select
      (select count(*)::int from otp_requests where phone = $1 and created_at > now() - interval '1 hour') as phone_hour,
      (select count(*)::int from otp_requests where created_at > now() - interval '1 day') as day`, [phone]);
  if (c.phone_hour >= LIMITS.perPhonePerHour()) throw refuseFor('too_many_requests');
  if (c.day >= LIMITS.perDay()) { console.warn(`[login] daily OTP cap reached (${c.day})`); throw refuseFor('unavailable'); }
  let ref = null;
  if (phone !== testPhone()) {
    if (!msg91.configured()) throw refuseFor('unavailable');
    try { ref = await msg91.sendOtp(phone); }
    catch (e) { console.warn(`[login] send failed: ${e.message}`); throw refuseFor(e.reason === 'invalid_number' || e.reason === 'too_many_requests' ? e.reason : 'unavailable'); }
  }
  const { rows: [r] } = await pool.query(`insert into otp_requests (phone, provider_ref, ip, expires_at) values ($1, $2, $3, now() + make_interval(secs => $4)) returning id`,
    [phone, ref, ip, EXPIRES_SEC]);
  // Old requests aren't needed once they've expired (keep a month for abuse checks).
  pool.query(`delete from otp_requests where created_at < now() - interval '30 days'`).catch(() => {});
  return { requestId: r.id, codeLength: CODE_LENGTH, resendAfterSec: RESEND_AFTER_SEC, expiresInSec: EXPIRES_SEC };
}

const pending = async (id) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw refuseFor('code_expired');
  const r = (await pool.query('select * from otp_requests where id = $1', [id])).rows[0];
  if (!r || r.verified_at || r.expires_at.getTime() < Date.now()) throw refuseFor('code_expired');
  return r;
};

async function resendCode(req) {
  const b = await readJson(req);
  const r = await pending(b.requestId);
  if (r.resends >= MAX_RESENDS) throw refuseFor('too_many_requests');
  if (Date.now() - r.last_sent_at.getTime() < RESEND_AFTER_SEC * 1000) throw refuseFor('too_many_requests');
  if (r.provider_ref) {
    try { await msg91.retryOtp(r.provider_ref, b.channel); }
    catch (e) { console.warn(`[login] resend failed: ${e.message}`); throw refuseFor(e.reason === 'too_many_requests' ? e.reason : 'unavailable'); }
  }
  await pool.query('update otp_requests set resends = resends + 1, last_sent_at = now() where id = $1', [r.id]);
  return { ok: true, resendAfterSec: RESEND_AFTER_SEC };
}

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

async function verifyCode(req) {
  const b = await readJson(req);
  const code = String(b.code || '').replace(/\D/g, '');
  if (code.length < 4 || code.length > 8) throw refuseFor('wrong_code');
  const r0 = await pending(b.requestId);
  // Count the try first, so parallel guesses can't get past the limit.
  const { rows: [r] } = await pool.query(`update otp_requests set attempts = attempts + 1 where id = $1 and attempts < $2 and verified_at is null returning *`, [r0.id, MAX_ATTEMPTS]);
  if (!r) throw refuseFor('too_many_requests');
  if (!r.provider_ref) {
    if (r.phone !== testPhone() || !same(code, process.env.MSG91_TEST_CODE)) throw refuseFor('wrong_code');
  } else {
    let accessToken, answer;
    try {
      accessToken = await msg91.verifyOtp(r.provider_ref, code);
      answer = await msg91.verifyAccessToken(accessToken);
    } catch (e) {
      if (e.reason === 'other' || e.reason === 'unavailable') console.warn(`[login] verify failed: ${e.message}`);
      throw refuseFor(e.reason === 'other' ? 'wrong_code' : e.reason);
    }
    // MSG91 says which number it verified: it must be the one this request was for.
    const check = msg91.identifierCheck(answer, r.phone);
    if (check === 'other') { console.error('[login] MSG91 verified a different number than requested'); throw refuseFor('wrong_code'); }
    if (check === 'absent') console.warn(`[login] MSG91 verifyAccessToken answer had no number (keys: ${Object.keys(answer).join(', ')}); trusting the request it was sent for`);
  }
  // One use only: a second verify of the same request finds it already used.
  const { rowCount } = await pool.query('update otp_requests set verified_at = now() where id = $1 and verified_at is null', [r.id]);
  if (!rowCount) throw refuseFor('code_expired');
  const user = await store.upsertUser({ firebaseUid: `phone:${r.phone}`, phone: r.phone });
  if (user.created) await store.addEvent({ userId: user.id, name: 'user.created', properties: { via: 'otp' } });
  const client = ['android', 'web', 'admin'].includes(b.client) ? b.client : null;
  const s = await sessions.create(user.id, r.phone, client);
  return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: { id: user.id, phone: r.phone, created: !!user.created } };
}

async function signedIn(req) {
  const who = await caller(req);
  if (!who?.sessionId) throw fail(401, 'login required');
  return who;
}

/** Handle /api/auth/*. → true when handled. */
export async function handleLogin(req, res, url) {
  if (!url.pathname.startsWith('/api/auth/')) return false;
  if (req.method !== 'POST') throw fail(405, 'POST only');
  if (!enabled()) throw refuseFor('unavailable');
  const p = url.pathname;
  if (p === '/api/auth/otp/send') return send(res, 200, await sendCode(req)), true;
  if (p === '/api/auth/otp/resend') return send(res, 200, await resendCode(req)), true;
  if (p === '/api/auth/otp/verify') return send(res, 200, await verifyCode(req)), true;
  if (p === '/api/auth/refresh') { const s = await sessions.refresh(await signedIn(req)); return send(res, 200, { token: s.token, expiresAt: s.expiresAt.toISOString() }), true; }
  if (p === '/api/auth/logout') { await sessions.revoke((await signedIn(req)).sessionId); return send(res, 200, { ok: true }), true; }
  throw fail(404, 'not found');
}
