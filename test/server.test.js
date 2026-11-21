import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockRest } from './mock-sarvam-rest.js';

let server, base, mock;
before(async () => {
  mock = await startMockRest({ transcript: 'Every morning I take the bus to work and it is crowded' });
  process.env.SARVAM_API_KEY = 'test-key';
  process.env.SARVAM_BASE_URL = mock.url;
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

test('config reports ready when a key is set', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), { ready: true });
});

test('mic test endpoint transcribes and scores against the expected sentence', async () => {
  const expect = 'Every morning I take the bus to work, and it is always crowded.';
  const r = await (await fetch(`${base}/api/lab/transcribe?expect=${encodeURIComponent(expect)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(100) })).json();
  assert.equal(r.transcript, 'Every morning I take the bus to work and it is crowded');
  assert.ok(r.accuracy > 0.8 && r.accuracy < 1, `accuracy ${r.accuracy}`);
  assert.equal(r.mode, 'codemix');
});

test('lab transcribe accepts every REST option and rejects invalid values', async () => {
  const ok = await fetch(`${base}/api/lab/transcribe?model=saaras:v3&mode=verbatim&language_code=hi-IN&with_timestamps=true&keyterms=${encodeURIComponent('["Sarvam","Pune"]')}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(32044) });
  const j = await ok.json();
  assert.equal(ok.status, 200);
  assert.deepEqual(j.options, { model: 'saaras:v3', mode: 'verbatim', language_code: 'hi-IN', with_timestamps: 'true', keyterms: '["Sarvam","Pune"]' });
  assert.equal(j.audioSec, 1);
  const bad = await fetch(`${base}/api/lab/transcribe?model=saarika:v1&mode=loud`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(100) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /model, mode/);
});

test('lab compare scores any transcript the same way as read-aloud', async () => {
  const r = await (await fetch(`${base}/api/lab/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: 'I paid two hundred and fifty rupees', heard: 'I paid ₹250' }) })).json();
  assert.equal(r.accuracy, 1);
  assert.equal(r.compared.heard, 'i paid 250 rupees');
});

test('voice streams as raw PCM, then comes from the cache', async () => {
  const say = () => fetch(`${base}/api/tts/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello there', lang: 'en-IN', pace: 1 }) });
  const first = await say();
  assert.equal(first.headers.get('content-type'), 'audio/pcm');
  assert.equal(first.headers.get('x-sample-rate'), '24000');
  assert.equal(first.headers.get('x-tts-cached'), 'false');
  assert.equal((await first.arrayBuffer()).byteLength, 9600);
  const again = await say();
  assert.equal(again.headers.get('x-tts-cached'), 'true');
  assert.equal((await again.arrayBuffer()).byteLength, 9600);
  assert.equal(mock.calls.filter((c) => c.path === '/text-to-speech/stream').length, 1, 'generated once');
});

test('old per-question endpoints are gone', async () => {
  for (const path of ['/api/turn', '/api/tts', '/api/final']) {
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', body: '{}' })).status, 404, path);
  }
});

test('the admin console on its own address: "/" there, and /admin/ elsewhere redirects to it', async () => {
  const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers });
  // Not set: /admin/ is the console and "/" the learner page, as before.
  assert.match(await (await get('/admin/')).text(), /\/admin\/admin\.js/);
  process.env.ADMIN_HOST = 'admin.adamspeaks.in';
  try {
    const viaHosting = { 'x-forwarded-host': 'admin.adamspeaks.in' };
    assert.match(await (await get('/', viaHosting)).text(), /\/admin\/admin\.js/);
    assert.equal((await get('/admin/admin.js', viaHosting)).status, 200, 'its files still load');
    assert.equal((await get('/api/admin/config', viaHosting)).status, 200);
    const old = await get('/admin/');
    assert.equal(old.status, 301);
    assert.equal(old.headers.get('location'), 'https://admin.adamspeaks.in/');
    assert.equal((await get('/admin')).headers.get('location'), 'https://admin.adamspeaks.in/');
    assert.doesNotMatch(await (await get('/')).text(), /\/admin\/admin\.js/, 'the main address is unchanged');
  } finally { delete process.env.ADMIN_HOST; }
});
