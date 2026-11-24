// Diagnostics (server/diag.js): a team phone sends its log, the server adds its side for requests that carry the
// code, and the log reads back by its code alone. Against a real PostgreSQL (TEST_DATABASE_URL; skipped without it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { startMockRest } from './mock-sarvam-rest.js';

const url = process.env.TEST_DATABASE_URL;
const PROJECT = 'sakhi-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let server, base, mock, pool;

before(async () => {
  if (!url) return;
  mock = await startMockRest();
  Object.assign(process.env, { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, DATABASE_URL: url, FIREBASE_PROJECT_ID: PROJECT, ADMIN_PHONES: '+919800000077' });
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  (await import('../server/auth.js')).setKeyResolver(async () => ({ k1: publicKey }));
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); mock?.close(); await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);

const now = Math.floor(Date.now() / 1000);
function login(uid, phone) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: uid, iat: now, exp: now + 3600, auth_time: now, phone_number: phone, firebase: { sign_in_provider: 'phone' } })}`;
  return { authorization: `Bearer ${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}` };
}
const call = async (method, path, headers = {}, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-sakhi-client': 'android', ...headers }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const team = login('fb-team', '+919800000077');
const learner = login('fb-learner', '+919800000088');
const CODE = 'a'.repeat(32);
const at = (ms) => new Date(Date.now() - ms).toISOString();

test('secrets are dropped and long text is cut, whatever sends it', async () => {
  const { clean, parseSince } = await import('../server/diag.js');
  assert.deepEqual(clean({ otp: '123456', token: 'x', phone: '+91', note: 'ok', nested: { Authorization: 'Bearer', n: 1 } }), { note: 'ok', nested: { n: 1 } });
  assert.equal(clean('x'.repeat(5000)).length, 1001);
  assert.ok(Math.abs(parseSince('30m').getTime() - (Date.now() - 30 * 60_000)) < 1000);
  assert.equal(parseSince('soon'), null);
});

test('the text form: one line an event, with the gap since the one before', async () => {
  const { asText } = await import('../server/diag.js');
  const s = asText({ diagId: CODE, from: at(0), total: 2, shown: 2, sessions: ['s1'], device: { model: 'Redmi' }, events: [
    { t: '2026-11-24T10:00:00.000Z', cat: 'conv', name: 'turn', src: 'app', sid: 's1', data: { ms: 900, lines: ['Hi there'] } },
    { t: '2026-11-24T10:00:00.250Z', cat: 'server', name: 'http', src: 'server', data: { status: 200 } }] });
  assert.match(s, /10:00:00\.000 +A \[conv\] turn sid=s1 ms=900 lines=\["Hi there"\]/);
  assert.match(s, /10:00:00\.250 +\+250ms S \[server\] http status=200/);
});

t('only team numbers send diagnostics', async () => {
  assert.equal((await call('GET', '/api/diag/status')).status, 401);
  assert.deepEqual((await call('GET', '/api/diag/status', learner)).json.enabled, false);
  assert.equal((await call('GET', '/api/diag/status', team)).json.enabled, true);
  const r = await call('POST', '/api/diag/logs', learner, { diagId: CODE, events: [{ t: at(0), cat: 'x', name: 'y' }] });
  assert.equal(r.status, 403);
  assert.equal((await call('POST', '/api/diag/logs', team, { diagId: 'short', events: [] })).status, 400);
});

t('a team phone sends its log; the server adds its side; anyone with the code reads it', async () => {
  // Before the phone has sent anything, requests with its code add nothing (no rows from strangers' codes).
  await call('GET', '/api/config', { 'x-adam-diag': 'b'.repeat(32) });
  const r = await call('POST', '/api/diag/logs', team, { diagId: CODE, device: { model: 'Redmi Note', run: 'r1' }, events: [
    { t: at(3000), seq: 1, cat: 'conv', name: 'start' },
    { t: at(2000), seq: 2, cat: 'conv', name: 'answer', sid: 'sess-1', data: { transcript: 'I play cricket', otp: '999999' } },
    { t: at(60 * 60_000 * 3), seq: 0, cat: 'app', name: 'old' },
  ] });
  assert.deepEqual(r.json, { saved: 3 });
  await call('GET', '/api/config', { 'x-adam-diag': CODE, 'x-request-id': 'rid-12345678' });
  await new Promise((ok) => setTimeout(ok, 300)); // the server's lines are saved after the answer
  const text = await call('GET', `/api/diag/logs/${CODE}?since=1h`);
  assert.equal(text.status, 200);
  assert.match(text.text, /\[conv\] answer sid=sess-1 transcript="I play cricket"/);
  const line = text.text.split('\n').find((l) => l.includes('S [server] http'));
  for (const part of ['rid=rid-12345678', 'method=GET', 'path=/api/config', 'status=200']) assert.ok(line.includes(part), line);
  assert.doesNotMatch(text.text, /999999/);
  assert.doesNotMatch(text.text, /\] old/); // older than asked
  const json = (await call('GET', `/api/diag/logs/${CODE}?format=json&since=1d&session=sess-1`)).json;
  assert.deepEqual(json.events.map((e) => e.name), ['answer']);
  assert.equal(json.device.model, 'Redmi Note');
  assert.deepEqual(json.sessions, ['sess-1']);
  assert.equal((await call('GET', `/api/diag/logs/${'b'.repeat(32)}`)).text.includes('0 of 0 events'), true);
  assert.equal((await call('GET', '/api/diag/logs/nope')).status, 404);
  assert.equal((await call('GET', `/api/diag/logs/${CODE}?since=whenever`)).status, 400);
});
