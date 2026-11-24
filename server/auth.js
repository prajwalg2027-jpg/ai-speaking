// Phone login: an SMS code (server/login.js, MSG91) and then the server's own sessions (server/sessions.js). The
// app sends the session token as "Authorization: Bearer <token>". (Firebase phone login was removed in Nov 2026.)
import * as sessions from './sessions.js';
import * as msg91 from './msg91.js';

/** OTP login (server/login.js): MSG91 or the test number, plus the server's own sessions. */
export const otpEnabled = () => sessions.enabled() && (msg91.configured() || !!(process.env.MSG91_TEST_PHONE && process.env.MSG91_TEST_CODE));
/** Login is on when OTP sign-in is set up. Production requires it (see server/index.js). */
export const loginEnabled = () => otpEnabled();

/**
 * The signed-in caller of an HTTP or WebSocket request, or null when there's no token. Throws 401 on a bad one.
 * → { uid, phone, userId, sessionId }
 */
export async function caller(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const token = m[1].trim();
  if (!sessions.isOurs(token)) throw Object.assign(new Error('login: unknown token'), { status: 401 });
  return sessions.verify(token);
}
