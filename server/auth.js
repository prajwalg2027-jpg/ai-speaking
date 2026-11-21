// Phone login (Firebase Authentication). The app signs in with phone OTP and sends Firebase's ID token as
// "Authorization: Bearer <token>". This checks it the way Firebase documents: RS256 signed by one of Google's
// published keys, for our project, not expired. No SDK needed: Node's crypto does the check.
import { createPublicKey, createVerify } from 'node:crypto';

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
import * as sessions from './sessions.js';
import * as msg91 from './msg91.js';

export const projectId = () => process.env.FIREBASE_PROJECT_ID || '';
export const firebaseEnabled = () => !!projectId();
/** OTP login (server/login.js): MSG91 or the test number, plus the server's own sessions. */
export const otpEnabled = () => sessions.enabled() && (msg91.configured() || !!(process.env.MSG91_TEST_PHONE && process.env.MSG91_TEST_CODE));
/** Login is on when either way of signing in is set up. Production requires it (see server/index.js). */
export const loginEnabled = () => firebaseEnabled() || otpEnabled();

let cache = { keys: null, until: 0 };
/** kid → public key, from Google (cached for as long as Google says). Replaceable in tests. */
let resolveKeys = async () => {
  if (cache.keys && Date.now() < cache.until) return cache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  const certs = await res.json();
  cache = { keys: Object.fromEntries(Object.entries(certs).map(([kid, pem]) => [kid, createPublicKey(pem)])), until: Date.now() + maxAge * 1000 };
  return cache.keys;
};
export const setKeyResolver = (fn) => { resolveKeys = fn; cache = { keys: null, until: 0 }; };

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const fail = (why) => Object.assign(new Error(`login: ${why}`), { status: 401 });

/** → { uid, phone } or throws (status 401). */
export async function verifyIdToken(token, now = Date.now() / 1000) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw fail('malformed token');
  let header, claims;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw fail('malformed token'); }
  if (header.alg !== 'RS256' || !header.kid) throw fail('wrong algorithm');
  const key = (await resolveKeys())[header.kid];
  if (!key) throw fail('unknown signing key');
  const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw fail('bad signature');
  const project = projectId();
  const skew = 60;
  if (claims.aud !== project) throw fail('token is for another project');
  if (claims.iss !== `https://securetoken.google.com/${project}`) throw fail('wrong issuer');
  if (!(claims.exp > now - skew)) throw fail('token expired');
  if (!(claims.iat <= now + skew) || !(claims.auth_time <= now + skew)) throw fail('token from the future');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw fail('no user');
  if (claims.firebase?.sign_in_provider !== 'phone') throw fail('only phone sign-in is accepted');
  return { uid: claims.sub, phone: claims.phone_number || null };
}

/**
 * The signed-in caller of an HTTP or WebSocket request, or null when there's no token. Throws on a bad one.
 * → { uid, phone } (Firebase), or { uid, phone, userId, sessionId } (an OTP login's session)
 */
export async function caller(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const token = m[1].trim();
  if (sessions.isOurs(token)) return sessions.verify(token);
  if (!firebaseEnabled()) throw Object.assign(new Error('login: unknown token'), { status: 401 });
  return verifyIdToken(token);
}
