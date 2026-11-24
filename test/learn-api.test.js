// The learning API and the admin console's API over HTTP, against a real PostgreSQL (TEST_DATABASE_URL; skipped
// without it) and the mock Sarvam: phone login, ownership, streaming (reply first), retries, lessons, admin access
// by phone number, live settings with an audit trail, the playground.
import { login, signInAll, SESSION_ENV } from './phone-login.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockRest } from './mock-sarvam-rest.js';

const url = process.env.TEST_DATABASE_URL;
let server, base, mock, pool;

before(async () => {
  if (!url) return;
  mock = await startMockRest();
  Object.assign(process.env, { ...SESSION_ENV, SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, DATABASE_URL: url, ADMIN_PHONES: '+919800009999,+919999900000', GOOGLE_GENAI_USE_VERTEXAI: 'false' }); // no Google Cloud sign-in (Vertex AI) in tests
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  await (await import('../server/learning/lessons.js')).sync(() => {});
  ({ server } = await import('../server/index.js'));
  await signInAll();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); mock?.close(); await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);

const call = async (method, path, headers = {}, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const asha = login('+919800000011'), ravi = login('+919800000012'), admin = login('+919800009999');
const testNumber = login('+919999900000');

let convId;
t('the learning API needs the phone login', async () => {
  const r = await call('GET', '/api/learn/profile');
  assert.equal(r.status, 401);
  assert.ok(r.headers.get('x-request-id'), 'every response has a request id');
  assert.equal((await call('GET', '/api/learn/profile', asha)).json.correctionIntensity, 'balanced');
});

t('a conversation starts with Sakhi\'s greeting, and only its owner can see it', async () => {
  const r = await call('POST', '/api/learn/conversations', asha, {});
  assert.equal(r.status, 201);
  assert.match(r.json.messages[0].content, /What would you like to talk about/);
  convId = r.json.conversation.id;
  assert.equal((await call('GET', `/api/learn/conversations/${convId}`, ravi)).status, 404);
  assert.equal((await call('GET', '/api/learn/conversations/not-a-uuid', asha)).status, 404);
  assert.equal((await call('GET', '/api/learn/conversations', ravi)).json.conversations.length, 0);
});

t('a message, streamed: the reply first, then the checked corrections, then everything', async () => {
  const res = await fetch(`${base}/api/learn/conversations/${convId}/messages`, { method: 'POST', headers: { ...asha, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ message: 'Yesterday I go to the market.', clientMessageId: 'c-1' }) });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const events = (await res.text()).trim().split('\n\n').map((b) => ({ name: b.match(/^event: (.*)$/m)[1], data: JSON.parse(b.match(/^data: (.*)$/m)[1]) }));
  assert.deepEqual(events.map((e) => e.name), ['reply', 'corrections', 'done']);
  assert.equal(events[0].data.reply, 'That sounds nice! What happened next?');
  assert.deepEqual(events[1].data.corrections.map((c) => c.corrected), ['I went']);
  assert.equal(events[2].data.replayed, false);
});

t('the same message again (a retry) returns the stored answer; bad input is refused', async () => {
  const r = await call('POST', `/api/learn/conversations/${convId}/messages`, asha, { message: 'Yesterday I go to the market.', clientMessageId: 'c-1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.replayed, true);
  assert.equal(r.json.corrections.length, 1);
  assert.equal((await call('POST', `/api/learn/conversations/${convId}/messages`, asha, { message: '' })).status, 400);
  assert.equal((await call('POST', `/api/learn/conversations/${convId}/messages`, ravi, { message: 'hi' })).status, 404, 'not Ravi\'s');
  const msgs = (await call('GET', `/api/learn/conversations/${convId}`, asha)).json.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['tutor', 'learner', 'tutor']);
  assert.equal(msgs[1].corrections[0].concept, 'past_simple');
});

t('preferences and progress', async () => {
  assert.equal((await call('PATCH', '/api/learn/preferences', asha, { correctionIntensity: 'loud' })).status, 400);
  assert.equal((await call('PATCH', '/api/learn/preferences', asha, { correctionIntensity: 'strict', goals: ['interviews'] })).status, 200);
  assert.deepEqual((await call('GET', '/api/learn/profile', asha)).json.goals, ['interviews']);
  const p = (await call('GET', '/api/learn/progress', asha)).json;
  assert.equal(p.activity.messages, 1);
  assert.equal(p.skills[0].concept, 'past_simple');
});

t('what Sakhi remembers: seen, forgotten one by one or all, and the learner\'s switch', async () => {
  const id = (await pool.query(`select id from users where phone = '+919800000011'`)).rows[0].id;
  await pool.query(`insert into learner_memories (user_id, kind, content) values ($1, 'fact', 'Works in a shop'), ($1, 'interest', 'Likes cricket')`, [id]);
  const m = (await call('GET', '/api/learn/memory', asha)).json;
  assert.equal(m.enabled, true);
  assert.deepEqual(m.items.map((i) => i.content).sort(), ['Likes cricket', 'Works in a shop']);
  assert.deepEqual((await call('GET', '/api/learn/memory', ravi)).json.items, [], 'only their own');
  assert.equal((await call('DELETE', `/api/learn/memory/${m.items[0].id}`, ravi)).status, 404, 'not Ravi\'s');
  assert.equal((await call('DELETE', '/api/learn/memory/abc', asha)).status, 404);
  assert.equal((await call('DELETE', `/api/learn/memory/${m.items[0].id}`, asha)).status, 200);
  assert.equal((await call('GET', '/api/learn/memory', asha)).json.items.length, 1);
  assert.equal((await call('DELETE', '/api/learn/memory', asha)).status, 200);
  assert.equal((await call('GET', '/api/learn/memory', asha)).json.items.length, 0);
  assert.equal((await call('PATCH', '/api/learn/preferences', asha, { memoryEnabled: false })).status, 200);
  assert.equal((await call('GET', '/api/learn/profile', asha)).json.memoryEnabled, false);
  assert.equal((await call('GET', '/api/learn/memory', asha)).json.enabled, false);
  assert.equal((await call('PATCH', '/api/learn/preferences', asha, { memoryEnabled: true })).status, 200);
});

t('lessons over HTTP: list, start, answer', async () => {
  const list = (await call('GET', '/api/learn/lessons', asha)).json.lessons;
  assert.ok(list.find((l) => l.id === 'articles-a-an-the'));
  const s = (await call('POST', '/api/learn/lessons/articles-a-an-the/start', asha)).json;
  const r = await call('POST', `/api/learn/lesson-sessions/${s.sessionId}/attempts`, asha, { exerciseId: s.exercise.id, answer: 'an', clientAttemptId: 'x' });
  assert.equal(r.json.verdict, 'correct');
  assert.equal(r.json.state.position, 2);
  assert.equal((await call('GET', `/api/learn/lesson-sessions/${s.sessionId}`, ravi)).status, 404, 'not Ravi\'s');
  assert.equal((await call('POST', '/api/learn/lessons/no-such/start', asha)).status, 404);
});

t('Sakhi\'s voice only for her own replies in the learner\'s conversations', async () => {
  const msgs = (await call('GET', `/api/learn/conversations/${convId}`, asha)).json.messages;
  const tutorMsg = msgs.find((m) => m.role === 'tutor'), learnerMsg = msgs.find((m) => m.role === 'learner');
  const ok = await fetch(`${base}/api/learn/messages/${tutorMsg.id}/speech`, { method: 'POST', headers: asha });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'audio/pcm');
  await ok.arrayBuffer();
  assert.equal((await call('POST', `/api/learn/messages/${tutorMsg.id}/speech`, ravi)).status, 404);
  assert.equal((await call('POST', `/api/learn/messages/${learnerMsg.id}/speech`, asha)).status, 404, 'not the learner\'s own words');
});

t('the admin console: config is public, everything else needs an admin phone number', async () => {
  assert.deepEqual((await call('GET', '/api/admin/config')).json, { loginRequired: true, login: 'otp' });
  assert.equal((await call('GET', '/api/admin/overview')).status, 401);
  assert.equal((await call('GET', '/api/admin/overview', asha)).status, 403);
  assert.equal((await call('GET', '/api/admin/overview', testNumber)).status, 403, 'the shared test number is never an admin');
  const o = await call('GET', '/api/admin/overview', admin);
  assert.equal(o.status, 200);
  assert.equal(o.json.totals.learners, 4, 'every signed-in number: Asha, Ravi, the admin and the test number');
  assert.equal(o.json.series.days.length, 14);
  assert.equal(o.json.series.messages.at(-1), 1);
});

t('admin settings: validated, applied at once, recorded with who changed them', async () => {
  const s = (await call('GET', '/api/admin/settings', admin)).json;
  assert.equal(s.sections.corrections.value.strategy, 'verify');
  assert.equal(s.providers.sarvam.configured, true);
  assert.equal(s.providers.openai.configured, false);
  const bad = await call('PUT', '/api/admin/settings/limits', admin, { value: { ...s.sections.limits.value, learnMessagesPerDay: -5 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /learnMessagesPerDay/);
  const noKey = await call('PUT', '/api/admin/settings/llm', admin, { value: { ...s.sections.llm.value, tutor: { provider: 'openai', model: 'x', temperature: 0.5 } } });
  assert.equal(noKey.status, 400, 'a provider without a key can\'t be chosen');
  assert.equal((await call('PUT', '/api/admin/settings/corrections', admin, { value: { ...s.sections.corrections.value, strategy: 'single' } })).status, 200);
  const r = await call('POST', `/api/learn/conversations/${convId}/messages`, asha, { message: 'Then I go home.' });
  assert.equal(r.json.meta.strategy, 'single', 'applied to the next message');
  const h = (await call('GET', '/api/admin/settings/history', admin)).json.changes;
  assert.equal(h[0].key, 'corrections');
  assert.equal(h[0].changed_by, '+919800009999');
  assert.equal((await call('POST', '/api/admin/settings/corrections/reset', admin)).json.value.strategy, 'verify');
});

t('admin playground compares A and B; conversations and lessons are listed', async () => {
  const p = await call('POST', '/api/admin/playground', admin, { message: 'Yesterday I go to work.', channel: 'text', intensity: 'balanced', level: 2 });
  assert.equal(p.status, 200);
  assert.equal(p.json.compare.single.corrections.length, 1);
  assert.equal(p.json.compare.verify.corrections.length, 1);
  const c = (await call('GET', '/api/admin/conversations', admin)).json.conversations;
  assert.ok(c.length >= 2);
  assert.match(c.find((x) => x.id === convId).phone, /^\+9198•••••011$/, 'phone partly hidden');
  const d = (await call('GET', `/api/admin/conversations/${convId}`, admin)).json;
  assert.ok(d.messages.some((m) => m.corrections.length));
  assert.ok((await call('GET', '/api/admin/lessons', admin)).json.lessons.find((l) => l.id === 'articles-a-an-the').started === 1);
  assert.equal((await call('GET', '/api/admin/evals', admin)).json.dataset.version, 'corrections-v1');
});
