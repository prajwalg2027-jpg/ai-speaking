// The conversation placement over HTTP (the app's API), and the admin's model comparison, against the mock AI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockRest } from './mock-sarvam-rest.js';

let server, base, mock, settings;
before(async () => {
  mock = await startMockRest();
  Object.assign(process.env, { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url });
  delete process.env.ANTHROPIC_API_KEY;
  settings = await import('../server/settings.js');
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });
const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json() }; };
const get = async (path) => (await fetch(`${base}${path}`)).json();
const WORDS = { '🐶': 'dog', '🏠': 'house', '🍌': 'banana', '🐟': 'fish', '🍞': 'bread' }; // the level 1 pictures

test('the app runs a whole conversation placement through the same API as the classic test', async () => {
  await settings.set('placement', { ...settings.get('placement'), mode: 'conversation' }, 'test');
  try {
    const start = (await post('/api/session')).json;
    assert.equal(start.task.id, 'hello');
    assert.equal(start.say.length, 2);
    const turn = (transcript) => post('/api/session/turn', { sessionId: start.sessionId, event: 'answer', transcript, speechSec: 5 });
    let t = (await turn('My name is Ravi')).json;
    assert.deepEqual([t.task.id, t.card.look], ['picture', 'emoji'], 'after the hello: a picture');
    t = (await turn(WORDS[t.card.text])).json;
    assert.deepEqual([t.task.id, t.card.kind, t.listen.language], ['read', 'read', 'en-IN']);
    t = (await turn(t.card.text)).json;
    assert.deepEqual([t.task.id, t.task.level, t.card], ['c1', 2, null], 'qualified: an open question');
    t = (await turn('In the morning I go to the market and bought some vegetables for my family')).json;
    assert.match(t.say.map((l) => l.text).join(' '), /Oh, you went there! Here is a level 4 question/);
    assert.equal(t.task.level, 4);
    t = (await turn('I like it because the vegetables are fresh there and the shopkeeper knows me well')).json;
    assert.equal(t.done.level, 3, 'two answers at level 3');
    assert.equal(t.done.mode, 'conversation');
    assert.match(t.done.practise[0], /I went/);
    assert.match(t.say.map((l) => l.text).join(' '), /Your English is at level 3 of 4, Good\./);
    // Every line she said can be spoken (the voice endpoint only speaks her own lines).
    const voice = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t.say[0].text, lang: t.say[0].lang, pace: t.say[0].pace, sessionId: start.sessionId }) });
    assert.equal(voice.status, 200);
  } finally { await settings.reset('placement', 'test'); }
  assert.equal((await post('/api/session')).json.task.id, 'q1_intro', 'back to the classic test');
});

test('comparing models: the same turn for each, with the level, speed and cost; a model without a key says so', async () => {
  const info = await get('/api/admin/placement-lab');
  assert.deepEqual([info.providers.sarvam.configured, info.providers.anthropic.configured], [true, false]);
  assert.equal(info.current.mode, 'classic');
  assert.ok(info.suggestions.anthropic.includes('claude-haiku-5-5'));
  assert.equal((await post('/api/admin/placement-lab/start', { primary: { provider: 'anthropic', model: 'claude-haiku-5-5' } })).status, 400, 'the driving model needs its key');
  const lab = (await post('/api/admin/placement-lab/start', {
    primary: { provider: 'sarvam', model: 'sarvam-105b-conversations' },
    others: [{ provider: 'sarvam', model: 'sarvam-105b', temperature: 0 }, { provider: 'anthropic', model: 'claude-haiku-5-5' }],
  })).json;
  assert.equal(lab.say.length, 2);
  assert.deepEqual(lab.models.map((m) => m.configured), [true, true, false]);
  assert.deepEqual(lab.question, { step: 'hello' });
  const type = async (message) => (await post('/api/admin/placement-lab/turn', { labId: lab.labId, message })).json;
  let t = await type('My name is Ravi');
  assert.deepEqual([t.question.step, t.primary.ms, t.others, t.ratings], ['picture', undefined, [], []], 'the name, picture and reading are fixed lines: no AI to compare');
  t = await type(WORDS[t.question.screen]);
  assert.equal(t.question.step, 'read');
  t = await type(t.question.screen);
  assert.deepEqual(t.question, { step: 'open', n: 1, level: 2 });
  t = (await post('/api/admin/placement-lab/turn', { labId: lab.labId, message: 'I go to office by bus every day and I work on the computer there' })).json;
  assert.deepEqual([t.primary.model, t.primary.level, t.primary.counted.level, t.primary.tip.said], ['sarvam/sarvam-105b-conversations', 3, 3, 'I go']);
  assert.ok(t.primary.ms >= 0 && t.primary.costInr > 0);
  assert.deepEqual([t.others[0].model, t.others[0].level, t.others[0].reply], ['sarvam/sarvam-105b', 3, 'Oh, you went there!']);
  assert.match(t.others[1].error, /API key is missing/);
  assert.deepEqual(t.question, { step: 'open', n: 2, level: 4 });
  t = (await post('/api/admin/placement-lab/turn', { labId: lab.labId, event: 'no_speech' })).json;
  assert.equal(t.primary.answered, false);
  assert.equal(t.question.n, 2);
  t = (await post('/api/admin/placement-lab/turn', { labId: lab.labId, message: 'Because my office is far from my home so the bus is cheap and easy for me' })).json;
  assert.equal(t.done.level, 3);
  assert.equal(t.done.primary.doingWell.length, 2);
  assert.ok(t.done.primary.costInr > 0 && t.done.primary.closing.includes('practise'), 'the first model\'s closing feedback has its cost and words too');
  assert.equal(t.done.others[0].closing.includes('practise'), true);
  assert.match(t.done.others[1].error, /API key is missing/);
  assert.deepEqual(t.ratings.map((r) => r.level), [3, 3]);
  assert.equal((await post('/api/admin/placement-lab/turn', { labId: lab.labId, message: 'more' })).status, 409);
});
