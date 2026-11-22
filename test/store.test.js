// Customer data against a real PostgreSQL (TEST_DATABASE_URL; skipped without it). The schema is rebuilt
// from the migrations each run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
let store, pool;
before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  const { migrate } = await import('../server/db/migrate.js');
  await migrate(pool, () => {});
  store = await import('../server/store.js');
});
after(async () => { await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

t('a phone login creates the customer once, and updates their phone', async () => {
  const a = await store.upsertUser({ firebaseUid: 'fb-1', phone: '+919800000001' });
  assert.equal(a.created, true);
  const b = await store.upsertUser({ firebaseUid: 'fb-1', phone: '+919800000002' });
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  assert.equal(b.phone, '+919800000002');
});

t('properties: only known keys and types, every change in the history with its source', async () => {
  const u = await store.upsertUser({ firebaseUid: 'fb-2', phone: '+919800000003' });
  assert.deepEqual(await store.setAttributes(u.id, { goal: 'job', city: 'Pune' }, 'signup'), { changed: ['goal', 'city'] });
  assert.deepEqual(await store.setAttributes(u.id, { goal: 'job' }, 'app'), { changed: [] }, 'no change, no history');
  await store.setAttributes(u.id, { goal: 'interview', name: 'Ravi' }, 'conversation');
  const now = await store.getUser(u.id);
  assert.deepEqual(now.attributes, { goal: 'interview', city: 'Pune', name: 'Ravi' });
  assert.equal(now.name, 'Ravi');
  const h = (await pool.query(`select key, old_value, new_value, source from attribute_history where user_id = $1 and key = 'goal' order by id`, [u.id])).rows;
  assert.deepEqual(h.map((r) => [r.old_value, r.new_value, r.source]), [[null, 'job', 'signup'], ['job', 'interview', 'conversation']]);
  await assert.rejects(store.setAttributes(u.id, { shoe_size: 9 }, 'app'), /unknown property/);
  await assert.rejects(store.setAttributes(u.id, { city: 42 }, 'app'), /must be a string/);
  await store.addConversationFacts(u.id, ['plays cricket', 'works in a shop', 'plays cricket']);
  assert.deepEqual((await store.getUser(u.id)).attributes.conversation_facts, ['plays cricket', 'works in a shop']);
});

t('a new property needs only a row in attribute_definitions', async () => {
  const u = await store.upsertUser({ firebaseUid: 'fb-3' });
  await pool.query(`insert into attribute_definitions (key, type, description, personal) values ('exam_target', 'string', 'Exam they are preparing for', false)`);
  assert.deepEqual(await store.setAttributes(u.id, { exam_target: 'IELTS' }, 'app'), { changed: ['exam_target'] });
  const found = await one(`select count(*)::int as n from users where attributes @> '{"exam_target":"IELTS"}'`);
  assert.equal(found.n, 1, 'queried with plain SQL, using the index');
});

t('consents: the latest answer counts; all four are needed before a test', async () => {
  const u = await store.upsertUser({ firebaseUid: 'fb-4' });
  assert.deepEqual(await store.missingConsents(u.id), ['terms', 'privacy', 'age_18_plus', 'recordings']);
  await store.addConsents(u.id, [{ purpose: 'terms', version: '2026-11', granted: true }, { purpose: 'privacy', version: '2026-11', granted: true },
    { purpose: 'age_18_plus', version: '2026-11', granted: true }, { purpose: 'recordings', version: '2026-11', granted: true }]);
  assert.deepEqual(await store.missingConsents(u.id), []);
  assert.ok((await store.getUser(u.id)).age_confirmed_at);
  await store.addConsents(u.id, [{ purpose: 'recordings', version: '2026-11', granted: false }]);
  assert.deepEqual(await store.missingConsents(u.id), ['recordings']);
});

t('a placement test: answers as they happen, then the level, level history, property and event', async () => {
  const u = await store.upsertUser({ firebaseUid: 'fb-5' });
  await store.startAssessment({ userId: u.id, sessionId: 'sess-5', client: 'android', appVersion: '0.1.0', scoringConfig: { levelCutoffs: { level4: 3 } } });
  const a1 = await store.saveAnswer('sess-5', { questionId: 'q1_intro', kind: 'open', variantLevel: 2, transcript: 'I play cricket', scores: { grammar: 2.5 }, features: { wordCount: 3 } });
  const a2 = await store.saveAnswer('sess-5', { questionId: 'q2_vocab', kind: 'vocab', transcript: 'running', skipped: false });
  assert.ok(a1 && a2);
  assert.deepEqual((await pool.query('select seq from assessment_answers order by seq')).rows.map((r) => r.seq), [1, 2]);
  await store.finishAssessment('sess-5', { level: 2, name: 'Basic', overall: 2.41, dims: { grammar: 2.5 }, reasons: [] }, 4.25);
  const a = await one(`select status, level, level_name, overall::float, cost_inr::float from assessments where session_id = 'sess-5'`);
  assert.deepEqual(a, { status: 'finished', level: 2, level_name: 'Basic', overall: 2.41, cost_inr: 4.25 });
  assert.equal((await one('select level from level_history where user_id = $1', [u.id])).level, 2);
  assert.equal((await store.getUser(u.id)).attributes.current_level, 2);
  assert.equal((await one(`select name from events where user_id = $1 and name = 'level.reached'`, [u.id])).name, 'level.reached');
});

t('app events: a retried send is stored once', async () => {
  const u = await store.upsertUser({ firebaseUid: 'fb-6' });
  for (let i = 0; i < 2; i++) await store.addEvent({ userId: u.id, name: 'screen.viewed', source: 'app', properties: { screen: 'result' }, clientEventId: 'c-1' });
  assert.equal((await one('select count(*)::int as n from events where user_id = $1', [u.id])).n, 1);
});

t('erasure removes the person and their recordings, keeps anonymised scores and proof', async () => {
  const u = await store.upsertUser({ firebaseUid: 'fb-7', phone: '+919800000007' });
  await store.setAttributes(u.id, { name: 'Priya', city: 'Pune' }, 'signup');
  await store.addConsents(u.id, [{ purpose: 'terms', version: 'v1', granted: true }]);
  await store.startAssessment({ userId: u.id, sessionId: 'sess-7' });
  const ans = await store.saveAnswer('sess-7', { questionId: 'q1_intro', transcript: 'My name is Priya from Pune', scores: { grammar: 3 } });
  await store.saveRecording({ userId: u.id, sessionId: 'sess-7', answerId: ans, storagePath: 'users/x/a.opus', codec: 'opus', durationSec: 4.2, bytes: 9000 });
  await store.finishAssessment('sess-7', { level: 3, name: 'Good', overall: 2.9, dims: {}, reasons: [] }, 3);
  const deleted = [];
  assert.deepEqual(await store.eraseUser(u.id, async (p) => { deleted.push(p); }), { recordings: 1 });
  assert.deepEqual(deleted, ['users/x/a.opus']);
  assert.equal(await store.getUser(u.id), null);
  assert.equal((await one(`select count(*)::int as n from attribute_history where user_id = $1`, [u.id])).n, 0);
  assert.equal((await one(`select count(*)::int as n from recordings where user_id = $1`, [u.id])).n, 0);
  const kept = await one(`select a.user_id, a.level, x.transcript, x.scores from assessments a join assessment_answers x on x.assessment_id = a.id where a.session_id = 'sess-7'`);
  assert.deepEqual(kept, { user_id: null, level: 3, transcript: null, scores: { grammar: 3 } });
  assert.equal((await one(`select count(*)::int as n from consents where purpose = 'terms' and version = 'v1' and user_id is null`)).n, 1, 'consent kept as proof');
  const e = await one('select completed_at, recordings from erasures order by id desc limit 1');
  assert.ok(e.completed_at); assert.equal(e.recordings, 1);
});
