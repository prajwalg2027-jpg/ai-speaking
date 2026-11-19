// Firebase ID token checks, with our own signing key standing in for Google's.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';

const PROJECT = 'sakhi-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
let auth;
before(async () => {
  process.env.FIREBASE_PROJECT_ID = PROJECT;
  auth = await import('../server/auth.js');
  auth.setKeyResolver(async () => ({ k1: publicKey }));
});

const now = Math.floor(Date.now() / 1000);
function token(claims = {}, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = { aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'uid-1', iat: now - 10, exp: now + 3600, auth_time: now - 10,
    phone_number: '+919800000001', firebase: { sign_in_provider: 'phone' }, ...claims };
  const head = `${enc({ alg, kid, typ: 'JWT' })}.${enc(body)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
}

test('a valid phone login token gives the user and their number', async () => {
  assert.deepEqual(await auth.verifyIdToken(token()), { uid: 'uid-1', phone: '+919800000001' });
});

test('bad tokens are refused', async () => {
  const cases = [
    ['not-a-token', /malformed/],
    [token({}, { key: other.privateKey }), /bad signature/],
    [token({}, { kid: 'nope' }), /unknown signing key/],
    [token({ aud: 'someone-else' }), /another project/],
    [token({ iss: 'https://evil.example' }), /wrong issuer/],
    [token({ exp: now - 600 }), /expired/],
    [token({ iat: now + 3600, auth_time: now + 3600 }), /future/],
    [token({ firebase: { sign_in_provider: 'anonymous' } }), /only phone/],
    [token({ sub: '' }), /no user/],
  ];
  for (const [t, why] of cases) await assert.rejects(auth.verifyIdToken(t), (e) => e.status === 401 && why.test(e.message), String(why));
});

test('the caller comes from the Authorization header', async () => {
  assert.equal(await auth.caller({ headers: {} }), null);
  assert.equal((await auth.caller({ headers: { authorization: `Bearer ${token()}` } })).uid, 'uid-1');
  await assert.rejects(auth.caller({ headers: { authorization: 'Bearer junk' } }), /malformed/);
});
