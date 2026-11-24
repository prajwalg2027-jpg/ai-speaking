// The server's own login sessions, for people who signed in with an OTP (server/login.js). The app holds a
// token (a JWT signed with SESSION_SECRET, HS256) naming its session; the session row decides whether it is
// still good, so signing out or deleting the account ends it everywhere within a minute.
//
//   SESSION_SECRET   at least 32 random characters (Secret Manager; deploy/msg91-setup.sh makes one)
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { pool } from './db/pool.js';

export const ISSUER = 'adamspeaks';
export const LIFETIME_DAYS = 60;
const secret = () => process.env.SESSION_SECRET || '';
export const enabled = () => secret().length >= 32 && !!pool;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');
const fail = (why) => Object.assign(new Error(`login: ${why}`), { status: 401 });

export function tokenFor({ userId, sessionId, phone, expiresAt }) {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: ISSUER, sub: userId, sid: sessionId, jti: randomUUID(), phone, iat: now, exp: Math.floor(expiresAt.getTime() / 1000) })}`;
  return `${head}.${sign(head)}`;
}

/** Is this one of our tokens? Only looks at the header. */
export function isOurs(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString()).alg === 'HS256'; } catch { return false; }
}

// Session id → still valid until (ms), so most requests don't need a database round trip.
const checked = new Map();
export const forget = (sessionId) => checked.delete(sessionId);
/** Before an account is erased: its sessions stop working at once, not after the minute they're trusted for. */
export async function forgetUser(userId) {
  if (!pool) return;
  for (const { id } of (await pool.query('select id from sessions where user_id = $1', [userId])).rows) checked.delete(id);
}

/** → { uid, phone, userId, sessionId } or throws 401. */
export async function verify(token, now = Date.now()) {
  if (!enabled()) throw fail('sessions are not set up on this server');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw fail('malformed token');
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`)), got = Buffer.from(parts[2]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw fail('bad signature');
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { throw fail('malformed token'); }
  if (c.iss !== ISSUER || !c.sub || !c.sid) throw fail('not our token');
  if (!(c.exp * 1000 > now)) throw fail('token expired');
  const hit = checked.get(c.sid);
  if (!hit || hit.until < now) {
    const s = (await pool.query('select user_id, expires_at, revoked_at from sessions where id = $1', [c.sid])).rows[0];
    if (!s || s.revoked_at || s.user_id !== c.sub || s.expires_at.getTime() <= now) { checked.delete(c.sid); throw fail('signed out'); }
    checked.set(c.sid, { until: now + 60_000 });
    if (checked.size > 50_000) checked.delete(checked.keys().next().value);
  }
  return { uid: `phone:${c.phone}`, phone: c.phone, userId: c.sub, sessionId: c.sid };
}

export async function create(userId, phone, client) {
  const expiresAt = new Date(Date.now() + LIFETIME_DAYS * 86400_000);
  const { rows: [s] } = await pool.query('insert into sessions (user_id, client, expires_at) values ($1, $2, $3) returning id', [userId, client || null, expiresAt]);
  return { token: tokenFor({ userId, sessionId: s.id, phone, expiresAt }), expiresAt };
}

/** A fresh token for a session that is still good (the app refreshes well before it expires). */
export async function refresh(who) {
  const expiresAt = new Date(Date.now() + LIFETIME_DAYS * 86400_000);
  const { rowCount } = await pool.query('update sessions set expires_at = $2, last_refreshed_at = now() where id = $1 and revoked_at is null', [who.sessionId, expiresAt]);
  if (!rowCount) throw fail('signed out');
  return { token: tokenFor({ userId: who.userId, sessionId: who.sessionId, phone: who.phone, expiresAt }), expiresAt };
}

export async function revoke(sessionId) {
  await pool.query('update sessions set revoked_at = now() where id = $1 and revoked_at is null', [sessionId]);
  forget(sessionId);
}
