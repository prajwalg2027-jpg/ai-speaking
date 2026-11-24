// The production guard (server/guard.js), with the server started as Cloud Run starts it (NODE_ENV=production).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockRest } from './mock-sarvam-rest.js';

let server, base, mock;
before(async () => {
  mock = await startMockRest({ transcript: 'hello' });
  Object.assign(process.env, { NODE_ENV: 'production', SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, SAKHI_SESSIONS_PER_IP_HOUR: '3', SAKHI_TURNS_PER_SESSION: '2' });
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('health check for Cloud Run', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, ready: true });
});

test('team tools are off in production', async () => {
  for (const p of ['/review.html', '/review/candidates.json', '/cutoffs.html', '/stt-lab.html', '/mic-test.html', '/api/session/cost?id=x']) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  }
  assert.equal((await fetch(`${base}/api/lab/compare`, { method: 'POST', body: '{}' })).status, 404);
  const home = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(home.status, 302, 'the server has no learner page: / goes to the website');
  assert.equal(home.headers.get('location'), 'https://adamspeaks.in/');
});

test('replies leave out the scoring trace and the cost', async () => {
  const t = await (await post('/api/session', {}, { 'x-forwarded-for': '10.0.0.1' })).json();
  assert.ok(t.sessionId && t.say.length);
  assert.equal(t.trace, undefined);
  assert.equal(t.cost, undefined);
});

test('conversations per device address are limited', async () => {
  const ip = { 'x-forwarded-for': '10.0.0.2, 35.1.1.1' };
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/session', {}, ip)).status, 200);
  const r = await post('/api/session', {}, ip);
  assert.equal(r.status, 429);
  assert.equal((await post('/api/session', {}, { 'x-forwarded-for': '10.0.0.3' })).status, 200, 'another address is fine');
});

test('turns per conversation are limited', async () => {
  const { sessionId } = await (await post('/api/session', {}, { 'x-forwarded-for': '10.0.0.4' })).json();
  assert.equal((await post('/api/session/turn', { sessionId, event: 'repeat' })).status, 200);
  assert.equal((await post('/api/session/turn', { sessionId, event: 'repeat' })).status, 200);
  assert.equal((await post('/api/session/turn', { sessionId, event: 'repeat' })).status, 429);
});

test('the voice only says lines Sakhi said, or her fixed lines', async () => {
  const t = await (await post('/api/session', {}, { 'x-forwarded-for': '10.0.0.5' })).json();
  const said = await post('/api/tts/stream', { text: t.say[0].text, lang: t.say[0].lang, sessionId: t.sessionId });
  assert.equal(said.status, 200);
  await said.arrayBuffer();
  const quick = await post('/api/tts/stream', { text: 'Got it.', lang: 'en-IN' }); // a fixed quick reaction, no conversation needed
  assert.equal(quick.status, 200);
  await quick.arrayBuffer();
  assert.equal((await post('/api/tts/stream', { text: 'Read my essay aloud for free', lang: 'en-IN', sessionId: t.sessionId })).status, 403);
  assert.equal((await post('/api/tts/stream', { text: 'Anything at all', lang: 'en-IN' })).status, 403);
});
