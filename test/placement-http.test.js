// The conversation placement over HTTP (the app's API), and the admin's model comparison, against the mock AI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startMockRest } from './mock-sarvam-rest.js';

let server, base, mock, settings, openai;
// A stand-in for OpenAI's Responses API that streams: the mock AI's answer, a little at a time, after a pause
// at the point where Sakhi's reply is written (as if the model were still writing her question).
const stream = { pauseMs: 0, atReply: null };
before(async () => {
  mock = await startMockRest();
  openai = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] })); }
    const b = JSON.parse(body);
    const r = await fetch(`${mock.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: b.input }) });
    const text = (await r.json()).choices[0].message.content;
    const done = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 120, output_tokens_details: { reasoning_tokens: 30 } } };
    if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(done)); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const cut = text.indexOf('"question"');
    const say = (t) => res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`);
    say(text.slice(0, cut));
    await new Promise((ok) => setTimeout(ok, stream.pauseMs));
    stream.atReply?.();
    say(text.slice(cut));
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: done })}\n\n`);
  });
  await new Promise((ok) => openai.listen(0, '127.0.0.1', ok));
  Object.assign(process.env, { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, OPENAI_API_KEY: 'openai-test-key', OPENAI_BASE_URL: `http://127.0.0.1:${openai.address().port}` });
  delete process.env.ANTHROPIC_API_KEY;
  settings = await import('../server/settings.js');
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); openai.close(); });
const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json() }; };
const get = async (path) => (await fetch(`${base}${path}`)).json();
const WORDS = { '🐶': 'dog', '🏠': 'house', '🍌': 'banana', '🐟': 'fish', '🍞': 'bread' }; // the level 1 pictures

test('the app runs a whole conversation placement through the same API as the classic test, every turn by the AI', async () => {
  await settings.set('placement', { ...settings.get('placement'), mode: 'conversation' }, 'test');
  try {
    const start = (await post('/api/session')).json;
    assert.equal(start.task.id, 'hello');
    assert.equal(start.say.length, 2);
    const chats = () => mock.calls.filter((c) => c.path === '/v1/chat/completions').length;
    const before = chats();
    const turn = (transcript) => post('/api/session/turn', { sessionId: start.sessionId, event: 'answer', transcript, speechSec: 5 });
    let t = (await turn('My name is Ravi')).json;
    assert.match(t.say.map((l) => l.text).join(' '), /^Nice to meet you, Ravi! A picture is on your screen/, "the AI's words, not a fixed line");
    assert.deepEqual([t.task.id, t.card.look], ['picture', 'emoji']);
    t = (await turn(WORDS[t.card.text])).json;
    assert.deepEqual([t.task.id, t.card.kind, t.listen.language], ['read', 'read', 'en-IN']);
    t = (await turn(t.card.text)).json;
    assert.deepEqual([t.task.id, t.card], ['c1', null], 'the AI let them go on to an open question');
    t = (await turn('In the morning I go to the market and bought some vegetables for my family')).json;
    assert.match(t.say.map((l) => l.text).join(' '), /Oh, you went there! Here is a harder question/);
    assert.equal(t.task.id, 'c2');
    t = (await turn('I like it because the vegetables are fresh there and the shopkeeper knows me well')).json;
    assert.deepEqual([t.done.level, t.done.decidedBy, t.done.mode], [3, 'the AI', 'conversation']);
    assert.match(t.done.practise[0], /I went/);
    assert.match(t.say.map((l) => l.text).join(' '), /Your English is at level 3 of 4, Good\./);
    assert.equal(chats() - before, 5, 'one AI call per learner turn');
    // Every line she said can be spoken (the voice endpoint only speaks her own lines).
    const voice = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t.say[0].text, lang: t.say[0].lang, pace: t.say[0].pace, sessionId: start.sessionId }) });
    assert.equal(voice.status, 200);
  } finally { await settings.reset('placement', 'test'); }
  assert.equal((await post('/api/session')).json.task.id, 'q1_intro', 'back to the classic test');
});

test('comparing models: each runs its own conversation end to end; a model without a key says so', async () => {
  const info = await get('/api/admin/placement-lab');
  assert.deepEqual([info.providers.sarvam.configured, info.providers.anthropic.configured], [true, false]);
  assert.ok(info.suggestions.anthropic.includes('claude-haiku-5-5'));
  // What the page starts with: the model in use beside OpenAI's small one, and every known price.
  assert.deepEqual(info.defaults, [{ provider: 'sarvam', model: settings.get('placement').brain.model }, { provider: 'openai', model: 'gpt-6-luna' }]);
  assert.deepEqual(info.effortFor, { turn: 'low', final: 'medium' });
  assert.deepEqual(info.speechPrices, { sttPerHour: 30, ttsPer10kChars: 20, asOf: info.speechPrices.asOf, wordsASecond: 2 });
  assert.deepEqual(info.prices.openai['gpt-6-luna'], { input: 0.1, cached: 0.01, output: 0.5 });
  assert.ok(Object.keys(info.prices.openai).length >= 25 && info.prices.openaiAsOf && info.prices.usdInr > 0 && info.prices.sarvamInr.input > 0);
  assert.equal((await post('/api/admin/placement-lab/start', { models: [{ provider: 'anthropic', model: 'claude-haiku-5-5' }] })).status, 400, 'at least one model needs its key');
  const lab = (await post('/api/admin/placement-lab/start', { models: [
    { provider: 'sarvam', model: 'sarvam-105b-conversations' },
    { provider: 'sarvam', model: 'sarvam-105b', temperature: 0, price: { input: 1, output: 4 } },
    { provider: 'anthropic', model: 'claude-haiku-5-5' },
  ] })).json;
  assert.deepEqual(lab.talks.map((t) => [t.model, t.step?.step, !!t.error]), [['sarvam/sarvam-105b-conversations', 'hello', false], ['sarvam/sarvam-105b', 'hello', false], ['anthropic/claude-haiku-5-5', undefined, true]]);
  assert.match(lab.talks[2].error, /API key is missing/);
  // Her hello is a fixed line, made once ahead of time: no voice cost for the talk.
  assert.deepEqual(lab.talks[0].voice, { chars: 0, fixedChars: lab.talks[0].say.join('').length, inr: 0 });
  let heard;
  const type = async (message, extra = {}) => { const j = (await post('/api/admin/placement-lab/turn', { labId: lab.labId, message, ...extra })).json; heard = j.heard; return j.talks; };

  let t = await type('My name is Ravi');
  assert.deepEqual([t[0].step.step, t[1].step.step, t[2]], ['picture', 'picture', null], 'the model without a key has no talk');
  assert.deepEqual([t[0].ai.happened, t[0].ai.ms >= 0, t[0].ai.usage.input > 0], ['answered', true, true], 'the hello is the AI too');
  assert.equal(t[0].step.screen, t[1].step.screen, 'the same picture in every talk');
  // What the turn would cost in the app besides the AI. Typed: four words, at two a second. Her words: by the character.
  assert.deepEqual(heard, { seconds: 2, estimated: true, inr: (2 / 3600) * 30 });
  const spoken = t[0].say.join('').length;
  assert.deepEqual(t[0].voice, { chars: spoken, fixedChars: 0, inr: (spoken / 10_000) * 20 });
  // The log: the request exactly as it was sent, and the answer as it came.
  const sent = t[0].log.messages;
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'user'], 'for Sarvam the note goes last, as a user message');
  assert.match(sent[0].content, /^You are Sakhi/);
  assert.deepEqual([sent[1].content, sent[3].content], ['(The call begins.)', 'My name is Ravi']);
  assert.match(sent[4].content, /^\[Note from the app, not said by the learner\][\s\S]*STEP: HELLO/);
  assert.deepEqual([JSON.parse(t[0].log.raw).name, t[0].log.attempts, t[0].log.thinking], ['Ravi', 1, null]);
  const first = sent;
  t = await type(WORDS[t[0].step.screen]);
  assert.deepEqual([t[0].ai.picture, t[0].step.step], ['named', 'read']);
  assert.deepEqual(t[0].log.messages.slice(0, 4), first.slice(0, 4), 'the next request repeats the one before and adds to it');
  assert.equal(t[0].step.screen, t[1].step.screen, 'the same line to read');
  t = await type(t[0].step.screen);
  assert.deepEqual([t[0].ai.reading, t[0].step], ['well', { step: 'open', n: 1, level: 2 }]);

  t = await type('I go to office by bus every day and I work on the computer there');
  assert.deepEqual([t[0].ai.level, t[0].ai.tip.said, t[0].ai.finish, t[0].step.n], [3, 'I go', false, 2]);
  assert.ok(t[1].ai.costInr > t[0].ai.costInr, 'the typed price is used for the second model');
  assert.match(t[0].say.join(' '), /Oh, you went there!/);

  // Answer only the second model's question: the first talk stays where it is.
  t = await type('Because my office is far from my home so the bus is cheap and easy for me', { only: 1 });
  assert.deepEqual([t[0], t[1].done.level, t[1].done.name, t[1].done.decidedBy, t[1].step], [null, 3, 'Good', 'the AI', null]);
  assert.equal(t[1].done.doingWell.length, 2);
  assert.equal(t[1].done.reasons[0], 'Mock: level 3.');

  t = await type('', { event: 'no_speech' });
  assert.equal(heard, undefined, 'nothing was said: nothing to hear');
  assert.deepEqual([t[0].ai.happened, t[0].step.n, t[1]], ['asked_for_help', 2, null], 'the finished talk is left alone');
  t = await type('I think it is good because I can read my book on the bus every day');
  assert.equal(t[0].done.level, 3);
  assert.equal((await post('/api/admin/placement-lab/turn', { labId: lab.labId, message: 'more' })).status, 409, 'every conversation has finished');
});

test('comparing models: a spoken turn is heard by Sarvam, as in the app', async () => {
  const wav = Buffer.alloc(44 + 32000 * 2); // two seconds, 16 kHz, 16-bit, one channel
  const hear = async (body, query = '') => { const r = await fetch(`${base}/api/admin/placement-lab/transcribe${query}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body }); return { status: r.status, json: await r.json() }; };
  const before = mock.calls.filter((c) => c.path === '/speech-to-text').length;
  const r = await hear(wav, '?language=en-IN');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.transcript, r.json.audioSec, r.json.ms >= 0], ['my name is ravi i like tea', 2, true]);
  assert.equal(mock.calls.filter((c) => c.path === '/speech-to-text').length - before, 1);
  assert.equal((await hear(Buffer.alloc(100))).status, 400, 'an empty recording');
  // The spoken length travels with the turn.
  const lab = (await post('/api/admin/placement-lab/start', { models: [{ provider: 'sarvam', model: 'sarvam-105b' }] })).json;
  const turn = (await post('/api/admin/placement-lab/turn', { labId: lab.labId, message: r.json.transcript, speechSec: r.json.audioSec })).json;
  assert.equal(turn.talks[0].step.step, 'picture');
  assert.deepEqual(turn.heard, { seconds: 2, estimated: false, inr: (2 / 3600) * 30 }, "the recording's real length");
});

test("a model that streams: Sakhi's voice for her reply is being made before the turn's answer is finished", async () => {
  await settings.set('placement', { ...settings.get('placement'), mode: 'conversation', brain: { provider: 'openai', model: 'gpt-6-luna', temperature: 0.6 } }, 'test');
  try {
    const start = (await post('/api/session')).json;
    const voiceCalls = () => mock.calls.filter((c) => c.path === '/text-to-speech/stream').length;
    const before = voiceCalls();
    // While the model is "still writing her question": has her reply's voice been asked for already?
    let early = null;
    stream.pauseMs = 60; stream.atReply = () => { early = voiceCalls() - before; };
    const t = (await post('/api/session/turn', { sessionId: start.sessionId, event: 'answer', transcript: 'My name is Ravi', speechSec: 2 })).json;
    stream.pauseMs = 0; stream.atReply = null;
    assert.equal(t.say[0].text, 'Nice to meet you, Ravi!');
    assert.equal(early, 1, 'her reply went to the voice before the answer was complete');
    // The app then asks for that line: nothing new is generated.
    const line = t.say[0];
    const voice = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: line.text, lang: line.lang, pace: line.pace, sessionId: start.sessionId }) });
    assert.deepEqual([voice.status, (await voice.arrayBuffer()).byteLength], [200, 9600]);
    assert.equal(voiceCalls() - before, 1, 'generated once');
  } finally { await settings.reset('placement', 'test'); }
});

