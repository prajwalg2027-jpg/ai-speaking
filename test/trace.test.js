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

const turn = (q, transcript, speechSec = 5) => fetch(`${base}/api/turn?q=${q}&level=2&speechSec=${speechSec}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript }),
}).then((r) => r.json());

test('config reports ready when a key is set', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), { ready: true });
});

test('scored turns return a step-by-step trace, with no translation step', async () => {
  const r = await turn(0, 'मेरा नाम Raju है। मैं shop में काम करता हूँ and I like cricket.');
  assert.equal(r.action, 'scored');
  assert.equal(r.englishMeaning, undefined);
  const steps = r.trace.map((s) => s.step);
  for (const s of ['input', 'question', 'clarify', 'features', 'heuristic', 'judge', 'reply', 'scores', 'level']) assert.ok(steps.includes(s), `missing ${s}`);
  assert.ok(!steps.includes('translate'), 'Hindi answers are no longer translated');
  assert.equal(r.trace.find((s) => s.step === 'judge').model, 'sarvam-105b');
  assert.equal(r.ack, 'Nice to meet you!');
  assert.ok(!mock.calls.some((c) => c.path === '/translate'));
});

test('clarification and unclear-audio turns explain themselves in the trace', async () => {
  const c = await turn(1, 'sorry, what?', 1);
  assert.equal(c.action, 'clarify');
  assert.equal(c.trace.at(-1).intent, 'repeat');
  const d = await turn(1, ' . ', 0.2);
  assert.equal(d.action, 'didnt_hear');
  assert.equal(d.trace.at(-1).step, 'check');
});

test('audio uploads to /api/turn are refused (no REST fallback)', async () => {
  const r = await fetch(`${base}/api/turn?q=0`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(100) });
  assert.equal(r.status, 415);
});

test('mic test endpoint transcribes and scores against the expected sentence', async () => {
  const expect = 'Every morning I take the bus to work, and it is always crowded.';
  const r = await (await fetch(`${base}/api/lab/transcribe?expect=${encodeURIComponent(expect)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(100) })).json();
  assert.equal(r.transcript, 'Every morning I take the bus to work and it is crowded');
  assert.ok(r.accuracy > 0.8 && r.accuracy < 1, `accuracy ${r.accuracy}`);
  assert.equal(r.mode, 'codemix');
});

test('voice responses report cache hits', async () => {
  const say = () => fetch(`${base}/api/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello there' }) }).then((r) => r.json());
  assert.equal((await say()).trace.cached, false);
  assert.equal((await say()).trace.cached, true);
});
