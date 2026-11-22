// MSG91's OTP Widget API, called from the server (the authkey never leaves it). Documented at
// https://docs.msg91.com/otp-widget: send OTP → request id; retry; verify OTP → a JWT access token; verify the
// access token → the verified identifier. Every answer is JSON with "type": "success" | "error"; errors can come
// back with HTTP 200, so the body decides.
//
//   MSG91_AUTHKEY     the account's authkey (Secret Manager)
//   MSG91_WIDGET_ID   the OTP widget's id (MSG91 dashboard → OTP → Widget)
//   MSG91_BASE_URL    optional, for tests
const base = () => process.env.MSG91_BASE_URL || 'https://control.msg91.com';
export const configured = () => !!(process.env.MSG91_AUTHKEY && process.env.MSG91_WIDGET_ID);

export class Msg91Error extends Error {
  constructor(message, { code = null, reason = 'other', status = 502 } = {}) { super(message); this.code = code; this.reason = reason; this.status = status; }
}

/** What went wrong, from MSG91's message, in our own words (the app shows a matching sentence). */
export function reasonOf(j) {
  const m = String(j?.message || j?.error || '').toLowerCase();
  if (/expire/.test(m)) return 'code_expired';
  if (/limit|exceed|too many|blocked/.test(m)) return 'too_many_requests';
  if (/mismatch|not match|invalid otp|incorrect|wrong/.test(m)) return 'wrong_code';
  if (/invalid.*(mobile|number|identifier)|(mobile|number|identifier).*invalid/.test(m)) return 'invalid_number';
  return 'other';
}

async function call(path, body) {
  let res;
  try {
    res = await fetch(`${base()}/api/v5/widget/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authkey: process.env.MSG91_AUTHKEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { throw new Msg91Error(`MSG91 unreachable: ${e.message}`, { reason: 'unavailable' }); }
  const j = await res.json().catch(() => null);
  if (!j) throw new Msg91Error(`MSG91 ${path}: HTTP ${res.status}, not JSON`, { reason: 'unavailable' });
  if (j.type !== 'success' || j.hasError) throw new Msg91Error(`MSG91 ${path}: ${j.message || j.error || 'error'}`, { code: j.code ?? null, reason: reasonOf(j) });
  return j;
}

/** Send an OTP to an E.164 number (+91…). → MSG91's request id */
export async function sendOtp(phone) {
  const j = await call('sendOtp', { widgetId: process.env.MSG91_WIDGET_ID, identifier: phone.replace(/^\+/, '') });
  if (typeof j.message !== 'string' || !j.message) throw new Msg91Error('MSG91 sendOtp: no request id');
  return j.message;
}

const CHANNELS = { sms: 11, voice: 4, whatsapp: 12 };
/** Send it again, on the widget's default channel or one of sms / voice / whatsapp. */
export async function retryOtp(reqId, channel) {
  await call('retryOtp', { widgetId: process.env.MSG91_WIDGET_ID, reqId, ...(CHANNELS[channel] ? { retryChannel: CHANNELS[channel] } : {}) });
}

/** Check the code. → the JWT access token */
export async function verifyOtp(reqId, otp) {
  const j = await call('verifyOtp', { widgetId: process.env.MSG91_WIDGET_ID, reqId, otp: String(otp) });
  if (typeof j.message !== 'string' || !j.message) throw new Msg91Error('MSG91 verifyOtp: no access token');
  return j.message;
}

/** Confirm the access token with MSG91 (with the authkey). → the whole answer (it carries the verified number) */
export async function verifyAccessToken(token) {
  return call('verifyAccessToken', { authkey: process.env.MSG91_AUTHKEY, 'access-token': token });
}

/** Every phone-like number in an answer (digits only, 10 or more), wherever MSG91 puts it. */
export function numbersIn(value, out = []) {
  if (typeof value === 'string' || typeof value === 'number') {
    for (const m of String(value).matchAll(/\+?\d[\d\s-]{8,}\d/g)) { const d = m[0].replace(/\D/g, ''); if (d.length >= 10) out.push(d); }
  } else if (value && typeof value === 'object') for (const v of Object.values(value)) numbersIn(v, out);
  return out;
}

/** Does MSG91's verified identifier belong to this number? → 'match' | 'other' (a different number) | 'absent' */
export function identifierCheck(answer, phone) {
  const want = phone.replace(/\D/g, '').slice(-10);
  const found = numbersIn(answer);
  if (!found.length) return 'absent';
  return found.some((d) => d.slice(-10) === want) ? 'match' : 'other';
}
