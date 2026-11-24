// A placement test left midway and carried on (server/placement/resume.js), against a real PostgreSQL
// (TEST_DATABASE_URL; skipped without it): the test saved after every turn, carried on after a short break and
// after a server release, a turn sent twice counted once, starting over, and the window running out.
import { login, signInAll, SESSION_ENV } from './phone-login.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockRest } from './mock-sarvam-rest.js';

const url = process.env.TEST_DATABASE_URL;
let server, base, mock, pool, classic, store, resume;

before(async () => {
  if (!url) return;
  mock = await startMockRest();
  Object.assign(process.env, { ...SESSION_ENV, SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, DATABASE_URL: url });
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  ({ server } = await import('../server/index.js'));
  classic = await import('../server/session.js');
  store = await import('../server/store.js');
  resume = await import('../server/placement/resume.js');
  await signInAll();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const h of [ravi, meena]) await call('POST', '/api/me/consents', h, { consents: ALL });
});
after(async () => { server?.close(); mock?.close(); await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);

const call = async (method, path, headers, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-sakhi-client': 'android', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const ALL = ['terms', 'privacy', 'age_18_plus', 'recordings'].map((purpose) => ({ purpose, version: '2026-11', granted: true }));
const ravi = login('+919800000021'), meena = login('+919800000022');
const saved = (sessionId) => one('select status, state, resumes from assessments where session_id = $1', [sessionId]);
const settle = (sessionId) => classic.getSession(sessionId)?.persist;

let sessionId, firstAsk;

t('nothing to carry on before the first answer', async () => {
  const start = await call('POST', '/api/session', ravi, {});
  assert.equal(start.status, 200);
  sessionId = start.json.sessionId;
  firstAsk = start.json.say.at(-1).text;
  const row = await saved(sessionId);
  assert.equal(row.status, 'in_progress');
  assert.ok(row.state, 'saved from the first turn');
  assert.equal((await call('POST', '/api/session/resume', ravi, { sessionId })).json.error, 'nothing_to_resume');
});

let askAfterOne;
t('each turn is saved; a turn sent twice (same seq) is answered once', async () => {
  const body = { sessionId, seq: 1, event: 'answer', transcript: 'My name is Ravi and I work in a shop in Nagpur.', languageCode: 'en-IN', speechSec: 4 };
  const t1 = await call('POST', '/api/session/turn', ravi, body);
  assert.equal(t1.status, 200);
  const again = await call('POST', '/api/session/turn', ravi, body);
  assert.equal(again.status, 200);
  assert.equal(again.json.again, true);
  assert.deepEqual(again.json.say, t1.json.say);
  await settle(sessionId);
  const { n } = await one('select count(*)::int as n from assessment_answers x join assessments a on a.id = x.assessment_id where a.session_id = $1', [sessionId]);
  assert.equal(n, 1, 'one answer, not two');
  const row = await saved(sessionId);
  assert.equal(row.state.seq, 1);
  assert.ok(row.state.history.some((h) => h.who === 'learner' && /Ravi/.test(h.text)));
  askAfterOne = t1.json.say.at(-1).text;
  assert.notEqual(askAfterOne, firstAsk);
});

t('a short break: she says they got cut off and asks the same question again', async () => {
  assert.deepEqual((await call('GET', '/api/session/resume', ravi)).json, { open: true, sessionId });
  assert.deepEqual((await call('GET', '/api/session/resume', meena)).json, { open: false });
  const r = await call('POST', '/api/session/resume', ravi, { sessionId });
  assert.equal(r.status, 200);
  assert.equal(r.json.resumed, true);
  assert.equal(r.json.sessionId, sessionId);
  assert.equal(r.json.seq, 1);
  assert.equal(r.json.say[0].text, resume.AGAIN.en);
  assert.ok(askAfterOne.endsWith(r.json.say.at(-1).text) && /more about that/.test(r.json.say.at(-1).text), 'the question, without her reaction before it');
  assert.ok(r.json.listen, 'and listens for the answer');
  await settle(sessionId);
  assert.equal((await saved(sessionId)).resumes, 1);
  // A turn from before the break can't be counted again.
  assert.equal((await call('POST', '/api/session/turn', ravi, { sessionId, seq: 1, event: 'skip' })).status, 409);
});

t('after a server release and an hour away: loaded from the database, welcomed back by name', async () => {
  await settle(sessionId);
  await pool.query(`update assessments set state = jsonb_set(state, '{at}', to_jsonb($2::bigint)) where session_id = $1`, [sessionId, Date.now() - 3600_000]);
  classic.forget(sessionId);
  // Without naming the test: their latest one.
  const r = await call('POST', '/api/session/resume', ravi, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.sessionId, sessionId);
  assert.match(r.json.say[0].text, /^Welcome back, Ravi!/);
  assert.ok(askAfterOne.endsWith(r.json.say.at(-1).text) && /more about that/.test(r.json.say.at(-1).text), 'the question, without her reaction before it');
  // The voice may say the welcome (it is one of her lines now).
  const voice = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: { 'content-type': 'application/json', ...ravi }, body: JSON.stringify({ text: r.json.say[0].text, sessionId }) });
  assert.equal(voice.status, 200);
  await voice.arrayBuffer();
  // And the test goes on.
  const t2 = await call('POST', '/api/session/turn', ravi, { sessionId, seq: 2, event: 'skip' });
  assert.equal(t2.status, 200);
  await settle(sessionId);
  assert.equal((await saved(sessionId)).state.seq, 2);
});

t('a turn straight after a release (no resume first) carries on from the database too', async () => {
  classic.forget(sessionId);
  const t3 = await call('POST', '/api/session/turn', ravi, { sessionId, seq: 3, event: 'skip' });
  assert.equal(t3.status, 200);
  assert.ok(classic.getSession(sessionId));
  await settle(sessionId);
});

t("someone else can't carry on Ravi's test", async () => {
  assert.equal((await call('POST', '/api/session/resume', meena, { sessionId })).json.error, 'nothing_to_resume');
  classic.forget(sessionId);
  assert.equal((await call('POST', '/api/session/turn', meena, { sessionId, event: 'skip' })).status, 404);
});

t('starting a new test is starting over: the one left midway is abandoned', async () => {
  const fresh = await call('POST', '/api/session', ravi, {});
  assert.equal(fresh.status, 200);
  const old = await saved(sessionId);
  assert.equal(old.status, 'abandoned');
  assert.equal(old.state, null);
  assert.equal((await call('POST', '/api/session/resume', ravi, { sessionId })).json.error, 'nothing_to_resume');
  assert.equal((await saved(fresh.json.sessionId)).status, 'in_progress');
  assert.deepEqual((await call('GET', '/api/session/resume', ravi)).json, { open: false }, 'the new test has no answer yet');
});

t('a test not carried on within the window is abandoned', async () => {
  const s = await call('POST', '/api/session', meena, {});
  const id = s.json.sessionId;
  await call('POST', '/api/session/turn', meena, { sessionId: id, seq: 1, event: 'answer', transcript: 'I am Meena.', languageCode: 'en-IN', speechSec: 2 });
  await settle(id);
  classic.forget(id);
  await pool.query(`update assessments set state_saved_at = now() - interval '25 hours' where session_id = $1`, [id]);
  assert.equal((await call('POST', '/api/session/resume', meena, { sessionId: id })).json.error, 'nothing_to_resume');
  assert.equal(await store.expireTests(24), 1);
  assert.deepEqual({ ...(await saved(id)) }, { status: 'abandoned', state: null, resumes: 0 });
});

t('the saved test is plain JSON without what only the running server needs', async () => {
  const s = classic.getSession((await call('POST', '/api/session', meena, {})).json.sessionId);
  s.saved = new WeakSet(); s.persist = Promise.resolve(); s.rec = { chunks: [Buffer.alloc(4)], bytes: 4 };
  const f = resume.freeze(s);
  for (const k of ['saved', 'persist', 'rec', 'prev', 'inFlight']) assert.equal(k in f, false, k);
  const back = resume.thaw({ ...f, id: 'thawed-test' });
  assert.ok(back.saved instanceof WeakSet);
  assert.equal(classic.getSession('thawed-test'), back);
  assert.deepEqual(back.task, JSON.parse(JSON.stringify(s.task)));
});

t('the conversation test carries on too: the question again, and the talk notes the break for the AI', async () => {
  const settings = await import('../server/settings.js');
  const conversation = await import('../server/placement/conversation.js');
  const before = settings.get('placement');
  await settings.set('placement', { ...before, mode: 'conversation' }, 'test');
  try {
    const s = await call('POST', '/api/session', meena, {});
    const id = s.json.sessionId;
    const t1 = await call('POST', '/api/session/turn', meena, { sessionId: id, seq: 1, event: 'answer', transcript: 'My name is Meena.', languageCode: 'en-IN', speechSec: 2 });
    assert.equal(t1.status, 200);
    await conversation.getSession(id).persist;
    conversation.forget(id);
    const r = await call('POST', '/api/session/resume', meena, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.sessionId, id);
    const live = conversation.getSession(id);
    assert.equal(live.mode, 'conversation');
    const asked = t1.json.say.slice(t1.json.cue.line).map((l) => l.text);
    assert.deepEqual(r.json.say.slice(r.json.cue.line).map((l) => l.text), asked);
    assert.ok(live.history.some((h) => h.who === 'app' && /left the talk for a while/.test(h.text)));
    const t2 = await call('POST', '/api/session/turn', meena, { sessionId: id, seq: 2, event: 'skip' });
    assert.equal(t2.status, 200);
  } finally { await settings.set('placement', before, 'test'); }
});
