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

test('comparing models: each runs its own conversation end to end, from the same start; a model without a key says so', async () => {
  const info = await get('/api/admin/placement-lab');
  assert.deepEqual([info.providers.sarvam.configured, info.providers.anthropic.configured], [true, false]);
  assert.equal(info.current.mode, 'classic');
  assert.ok(info.suggestions.anthropic.includes('claude-haiku-5-5'));
  assert.equal((await post('/api/admin/placement-lab/start', { models: [{ provider: 'anthropic', model: 'claude-haiku-5-5' }] })).status, 400, 'at least one model needs its key');
  const lab = (await post('/api/admin/placement-lab/start', { models: [
    { provider: 'sarvam', model: 'sarvam-105b-conversations' },
    { provider: 'sarvam', model: 'sarvam-105b', temperature: 0, price: { input: 1, output: 4 } },
    { provider: 'anthropic', model: 'claude-haiku-5-5' },
  ] })).json;
  assert.deepEqual(lab.talks.map((t) => [t.model, t.step?.step, !!t.error]), [['sarvam/sarvam-105b-conversations', 'hello', false], ['sarvam/sarvam-105b', 'hello', false], ['anthropic/claude-haiku-5-5', undefined, true]]);
  assert.match(lab.talks[2].error, /API key is missing/);
  const type = async (message, extra = {}) => (await post('/api/admin/placement-lab/turn', { labId: lab.labId, message, ...extra })).json.talks;

  let t = await type('My name is Ravi');
  assert.deepEqual([t[0].step.step, t[1].step.step, t[2], t[0].ai], ['picture', 'picture', null, undefined], 'fixed steps: no AI; the model without a key has no talk');
  assert.equal(t[0].step.screen, t[1].step.screen, 'the same picture in every talk');
  t = await type(WORDS[t[0].step.screen]);
  assert.equal(t[0].step.screen, t[1].step.screen, 'the same line to read');
  t = await type(t[0].step.screen);
  assert.deepEqual([t[0].step, t[0].say.at(-2)], [{ step: 'open', n: 1, level: 2 }, t[1].say.at(-2)], 'the same first open question');

  t = await type('I go to office by bus every day and I work on the computer there');
  assert.deepEqual([t[0].ai.level, t[0].counted.level, t[0].ai.tip.said, t[0].step], [3, 3, 'I go', { step: 'open', n: 2, level: 4 }]);
  assert.ok(t[0].ai.ms >= 0 && t[0].ai.costInr > 0 && t[0].ai.usage.input > 0);
  assert.ok(t[1].ai.costInr > t[0].ai.costInr, 'the typed price is used for the second model');
  assert.match(t[0].say.join(' '), /Oh, you went there!/);

  // Answer only the second model's question: the first talk stays where it is.
  t = await type('Because my office is far from my home so the bus is cheap and easy for me', { only: 1 });
  assert.deepEqual([t[0], t[1].done.level, t[1].done.name, t[1].step], [null, 3, 'Good', null]);
  assert.equal(t[1].done.doingWell.length, 2);
  assert.ok(t[1].done.ai.costInr > 0, "the closing feedback's own cost");
  assert.match(t[1].done.reasons[1], /levels 3, 3: level 3 was reached twice/);

  t = await type('', { event: 'no_speech' });
  assert.deepEqual([t[0].ai.answered, t[0].step.n, t[1]], [false, 2, null], 'the finished talk is left alone');
  t = await type('I think it is good because I can read my book on the bus every day');
  assert.equal(t[0].done.level, 3);
  assert.deepEqual(t[0].ratings.map((r) => r.level), [3, 3]);
  assert.equal((await post('/api/admin/placement-lab/turn', { labId: lab.labId, message: 'more' })).status, 409, 'every conversation has finished');
});
