import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let server, base;
before(async () => {
  delete process.env.SARVAM_API_KEY; // demo mode: no Sarvam calls, deterministic trace
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const turn = (q, transcript, speechSec = 5) => fetch(`${base}/api/turn?q=${q}&level=2&speechSec=${speechSec}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript }),
}).then((r) => r.json());

test('scored turns return a step-by-step trace for the log panel', async () => {
  const r = await turn(0, 'Hi, my name is Priya and I work as a teacher in a small school near Pune.');
  assert.equal(r.action, 'scored');
  assert.equal(typeof r.serverMs, 'number');
  assert.deepEqual(r.trace.map((s) => s.step), ['input', 'question', 'clarify', 'features', 'heuristic', 'scores', 'level']);
  for (const s of r.trace) assert.equal(typeof s.at, 'number');
  assert.equal(r.trace.find((s) => s.step === 'level').provisionalLevel, r.provisionalLevel);
});

test('clarification and unclear-audio turns explain themselves in the trace', async () => {
  const c = await turn(1, 'sorry, what?', 1);
  assert.equal(c.action, 'clarify');
  assert.deepEqual(c.trace.at(-1), { ...c.trace.at(-1), step: 'clarify', intent: 'repeat', by: 'keyword match' });
  const d = await turn(1, ' . ', 0.2);
  assert.equal(d.action, 'didnt_hear');
  assert.equal(d.trace.at(-1).step, 'check');
});
