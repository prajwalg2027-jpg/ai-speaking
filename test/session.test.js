import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockRest } from './mock-sarvam-rest.js';

let server, base, mock;
before(async () => {
  mock = await startMockRest();
  process.env.SARVAM_API_KEY = 'test-key';
  process.env.SARVAM_BASE_URL = mock.url;
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const answer = (sessionId, transcript, speechSec = 6) => post('/api/session/turn', { sessionId, event: 'answer', transcript, languageCode: 'en-IN', speechSec });

/** Play a whole conversation as a fluent learner; returns every turn. */
async function converse({ askWhatOnVocab = false } = {}) {
  const turns = [await post('/api/session', {})];
  let asked = false;
  for (let i = 0; i < 20 && !turns.at(-1).done; i++) {
    const t = turns.at(-1);
    let reply;
    if (t.task.kind === 'read') reply = t.card.text;
    else if (t.task.kind === 'vocab') {
      if (askWhatOnVocab && !asked) { asked = true; reply = 'sorry, what?'; }
      else reply = 'Responsibility. And a deadline is the last date by which you must finish a task.';
    } else reply = 'I work as a teacher in a small school near Pune, and in the evenings I usually go for a long walk with my friends because it helps me relax after work.';
    turns.push(await answer(t.sessionId, reply, 8));
  }
  return turns;
}

test('the conversation opens with the same greeting and listens with auto language', async () => {
  const t = await post('/api/session', {});
  assert.equal(t.status, 200);
  assert.match(t.sessionId, /^[0-9a-f-]{36}$/);
  assert.match(t.say[0].text, /I'm Sakhi/);
  assert.deepEqual(t.listen, { silenceMs: 1400, language: 'auto' });
  assert.equal(t.card, null);
});

test('a whole conversation: follow-ups after open answers, cards for tasks, a spoken summary at the end', async () => {
  const turns = await converse({ askWhatOnVocab: true });
  const ids = turns.filter((t) => t.task).map((t) => t.task.id);
  assert.equal(ids[0], 'q1_intro');
  assert.equal(ids[1], 'q1_intro_followup', 'a follow-up after the introduction');
  assert.ok(ids.includes('q2_vocab') && ids.includes('q3_read') && ids.includes('q4_opinion') && ids.includes('q4_opinion_followup'));
  const vocab = turns.find((t) => t.task?.id === 'q2_vocab');
  assert.ok(vocab.card, 'vocabulary shows its card');
  const read = turns.find((t) => t.task?.id === 'q3_read');
  assert.equal(read.card.kind, 'read');
  assert.equal(read.listen.language, 'en-IN', 'read-aloud listens in English');
  assert.ok(!read.say[0].text.includes(read.card.text), 'Sakhi never reads the sentence out');
  // "sorry, what?" repeats the same task line more slowly.
  const i = turns.findIndex((t) => t.heard === 'sorry, what?');
  assert.ok(i > 0);
  assert.equal(turns[i].say[0].pace, 0.8);
  assert.equal(turns[i].say[0].text, turns[i - 1].say[0].text.replace('Thanks for sharing that. ', ''));
  // Tutor lines passed the guardrails (no fallbacks with a well-behaved model).
  const steps = turns.flatMap((t) => t.trace || []).map((s) => s.step);
  assert.ok(steps.includes('tutor'));
  assert.ok(!steps.includes('tutor-fallback'));
  const end = turns.at(-1);
  assert.ok(end.done && end.done.level >= 1 && end.done.level <= 4);
  assert.match(end.say[0].text, new RegExp(end.done.name));
  assert.equal(end.listen, null);
});

test('a line that gives away the answer is replaced by the scripted one', async () => {
  mock.state.tutorMode = 'leak';
  try {
    let t = await post('/api/session', {});
    t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
    t = await answer(t.sessionId, 'I teach English and maths to small children every morning at the school.');
    assert.equal(t.task.id, 'q2_vocab');
    const fallback = t.trace.find((s) => s.step === 'tutor-fallback');
    assert.match(fallback.reason, /gives away/);
    assert.doesNotMatch(t.say[0].text, /\b(responsibility|umbrella|apple|self-reliant)\b/i);
  } finally { mock.state.tutorMode = 'good'; }
});

test('help requests climb the ladder: repeat slower, then Hindi, then move on', async () => {
  let t = await post('/api/session', {});
  const ask = t.say[0].text;
  t = await post('/api/session/turn', { sessionId: t.sessionId, event: 'repeat' });
  assert.equal(t.say[0].text, ask); assert.equal(t.say[0].pace, 0.8);
  t = await post('/api/session/turn', { sessionId: t.sessionId, event: 'no_speech' });
  assert.equal(t.say.length, 2, 'simpler English, then Hindi');
  assert.equal(t.say[1].lang, 'hi-IN');
  t = await post('/api/session/turn', { sessionId: t.sessionId, event: 'no_speech' });
  assert.equal(t.task.id, 'q2_vocab', 'moved on after the third');
  assert.equal(t.task.level, 1, 'no answer to the introduction → beginner versions');
});

test('unclear audio asks again, three times at most', async () => {
  let t = await post('/api/session', {});
  for (let n = 0; n < 2; n++) {
    t = await answer(t.sessionId, '.', 0.2);
    assert.match(t.say[0].text, /couldn't hear/);
    assert.equal(t.task.id, 'q1_intro');
  }
  t = await answer(t.sessionId, '.', 0.2);
  assert.equal(t.task.id, 'q2_vocab');
});

test('unknown sessions and events are refused', async () => {
  assert.equal((await post('/api/session/turn', { sessionId: 'nope', event: 'answer' })).status, 404);
  const t = await post('/api/session', {});
  assert.equal((await post('/api/session/turn', { sessionId: t.sessionId, event: 'dance' })).status, 400);
});
