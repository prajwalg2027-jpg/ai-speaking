// Truecaller one-tap sign-in (OAuth SDK 3.3, https://docs.truecaller.com). The app gets an authorization code
// from the Truecaller app (with a PKCE code challenge); the server exchanges it for an access token and reads the
// verified number from Truecaller itself, so the app can't claim a number it doesn't own.
//
//   TRUECALLER_CLIENT_IDS   the app's client ids from Truecaller's developer console (comma-separated: test
//                           build and release build each have one)
//   TRUECALLER_BASE_URL     optional, for tests
const base = () => process.env.TRUECALLER_BASE_URL || 'https://oauth-account-noneu.truecaller.com';
export const clientIds = () => String(process.env.TRUECALLER_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
export const configured = () => clientIds().length > 0;

export class TruecallerError extends Error {
  constructor(message, reason = 'truecaller_failed') { super(message); this.reason = reason; }
}

/** Exchange the authorization code (with its PKCE verifier) for an access token. */
export async function accessToken({ clientId, code, codeVerifier }) {
  let res;
  try {
    res = await fetch(`${base()}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { throw new TruecallerError(`Truecaller unreachable: ${e.message}`, 'unavailable'); }
  const j = await res.json().catch(() => ({}));
  if (res.status === 429 || res.status >= 500) throw new TruecallerError(`Truecaller token: HTTP ${res.status}`, 'unavailable');
  if (!res.ok || typeof j.access_token !== 'string') throw new TruecallerError(`Truecaller token: HTTP ${res.status} ${j.error || ''} ${j.error_description || ''}`.trim());
  return { token: j.access_token, scope: String(j.scope || '') };
}

/** The verified profile for an access token. → { phone: '+91…', name } */
export async function profile(token) {
  let res;
  try {
    res = await fetch(`${base()}/v1/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch (e) { throw new TruecallerError(`Truecaller unreachable: ${e.message}`, 'unavailable'); }
  if (res.status >= 500) throw new TruecallerError(`Truecaller userinfo: HTTP ${res.status}`, 'unavailable');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new TruecallerError(`Truecaller userinfo: HTTP ${res.status} ${j.message || ''}`.trim());
  if (j.phone_number_verified !== true) throw new TruecallerError('Truecaller: the number is not verified');
  const digits = String(j.phone_number || '').replace(/\D/g, '');
  if (!digits) throw new TruecallerError('Truecaller: no phone number (was the phone scope granted?)');
  const name = [j.given_name, j.family_name].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim() || null;
  return { phone: `+${digits}`, name };
}
