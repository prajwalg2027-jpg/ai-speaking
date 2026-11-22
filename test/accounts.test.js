// The customer flow end to end, against a real PostgreSQL (TEST_DATABASE_URL; skipped without it): phone login,
// consents, properties, a whole placement test saved as it happens, a voice recording, ownership, erasure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockRest } from './mock-sarvam-rest.js';

const url = process.env.TEST_DATABASE_URL;
const PROJECT = 'sakhi-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let server, base, mock, pool, dir, getSession, recordings;

before(async () => {
  if (!url) return;
  dir = await mkdtemp(join(tmpdir(), 'sakhi-rec-'));
  mock = await startMockRest();
  Object.assign(process.env, { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, DATABASE_URL: url, FIREBASE_PROJECT_ID: PROJECT, RECORDINGS_DIR: dir });
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  (await import('../server/auth.js')).setKeyResolver(async () => ({ k1: publicKey }));
  ({ server } = await import('../server/index.js'));
  ({ getSession } = await import('../server/session.js'));
  recordings = await import('../server/recordings.js');
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
const call = async (method, path, headers, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-sakhi-client': 'android', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const rows = async (sql, p) => (await pool.query(sql, p)).rows;
const ALL = ['terms', 'privacy', 'age_18_plus', 'recordings'].map((purpose) => ({ purpose, version: '2026-11', granted: true }));

let sessionId;
const priya = login('fb-priya', '+919800000011');

t('no login, no conversation; then the consents come first', async () => {
  assert.equal((await call('POST', '/api/session', {}, {})).status, 401);
  const r = await call('POST', '/api/session', priya, {});
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: 'consent_required', missing: ['terms', 'privacy', 'age_18_plus', 'recordings'] });
  assert.deepEqual((await call('POST', '/api/me/consents', priya, { consents: ALL })).json, { missingConsents: [] });
  assert.deepEqual((await call('PATCH', '/api/me/attributes', priya, { attributes: { goal: 'job', city: 'Pune' }, source: 'signup' })).json, { changed: ['goal', 'city'] });
  const me = (await call('GET', '/api/me', priya)).json;
  assert.equal(me.phone, '+919800000011');
  assert.deepEqual(me.attributes, { goal: 'job', city: 'Pune' });
  assert.deepEqual(me.missingConsents, []);
});

t('a placement test is saved as it happens, with the answer recording, and only its owner can use it', async () => {
  const start = await call('POST', '/api/session', priya, {});
  assert.equal(start.status, 200);
  sessionId = start.json.sessionId;
  // Someone else can't continue Priya's conversation.
  assert.equal((await call('POST', '/api/session/turn', login('fb-other', '+919800000099'), { sessionId, event: 'repeat' })).status, 403);
  // Her first answer, with its audio arriving through the live connection as it does from the app.
  recordings.collect(getSession(sessionId), Buffer.alloc(16000 * 2 * 2, 1)); // 2 s
  const t1 = await call('POST', '/api/session/turn', priya, { sessionId, event: 'answer', transcript: 'My name is Priya and I teach small children in a school near Pune.', languageCode: 'en-IN', speechSec: 5 });
  assert.equal(t1.status, 200);
  let turn = t1.json;
  for (let i = 0; i < 25 && !turn.done; i++) turn = (await call('POST', '/api/session/turn', priya, { sessionId, event: 'skip' })).json;
  assert.ok(turn.done, 'the test finished');
  await getSession(sessionId).persist;

  const [a] = await rows(`select a.status, a.level, a.client, u.phone from assessments a join users u on u.id = a.user_id where a.session_id = $1`, [sessionId]);
  assert.deepEqual(a, { status: 'finished', level: turn.done.level, client: 'android', phone: '+919800000011' });
  const answers = await rows(`select question_id, transcript from assessment_answers x join assessments a on a.id = x.assessment_id where a.session_id = $1 order by seq`, [sessionId]);
  assert.ok(answers.length >= 4, `${answers.length} answers saved`);
  assert.match(answers[0].transcript, /Priya/);
  const [lv] = await rows(`select level from level_history`);
  assert.equal(lv.level, turn.done.level);
  const names = (await rows(`select name from events where session_id = $1 order by id`, [sessionId])).map((e) => e.name);
  assert.equal(names[0], 'assessment.started');
  assert.ok(names.includes('answer.submitted') && names.includes('level.reached'));
  const me = (await call('GET', '/api/me', priya)).json;
  assert.equal(me.attributes.current_level, turn.done.level);
  assert.equal(me.attributes.name, 'Priya', 'learned in conversation');

  const [rec] = await rows(`select storage_path, codec, duration_sec::float, bytes from recordings`);
  assert.equal(rec.codec, 'opus');
  assert.equal(rec.duration_sec, 2);
  const file = await readFile(join(dir, rec.storage_path));
  assert.equal(file.subarray(0, 4).toString(), 'OggS', 'a real Ogg Opus file');
  assert.ok(file.length < 16000 * 2 * 2 / 5, `compressed (${file.length} bytes for 2 s)`);
});

t('the live speech connection needs the login too', async () => {
  const { default: WebSocket } = await import('ws');
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/live`);
    ws.on('unexpected-response', (_q, r) => resolve(r.statusCode));
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('error', () => {});
  });
  assert.equal(status, 401);
});

t('app events are stored once each', async () => {
  const ev = { events: [{ name: 'screen.viewed', clientEventId: 'e1', properties: { screen: 'result' } }, { name: 'Bad Name', clientEventId: 'e2' }] };
  assert.deepEqual((await call('POST', '/api/events', priya, ev)).json, { saved: 1 });
  await call('POST', '/api/events', priya, ev);
  assert.equal((await rows(`select count(*)::int as n from events where source = 'app'`))[0].n, 1);
});

t('erasing removes the person, their recordings and properties; anonymised scores stay', async () => {
  const [rec] = await rows(`select storage_path from recordings`);
  const r = await call('DELETE', '/api/me', priya);
  assert.deepEqual(r.json, { erased: true, recordings: 1 });
  await assert.rejects(stat(join(dir, rec.storage_path)), /ENOENT/);
  assert.equal((await rows(`select count(*)::int as n from users`))[0].n, 1, 'only the other caller remains');
  const [a] = await rows(`select user_id, level from assessments where session_id = $1`, [sessionId]);
  assert.equal(a.user_id, null); assert.ok(a.level);
  assert.equal((await rows(`select count(*)::int as n from assessment_answers where transcript is not null`))[0].n, 0);
});
