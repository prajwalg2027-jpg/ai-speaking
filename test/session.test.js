import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockRest } from './mock-sarvam-rest.js';
import { QUESTIONS, PHRASES } from '../shared/assessment.js';

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

// ---- coherence: memory, replies that aren't answers, Hindi, half answers ----------------------------

test('a correction is not scored as an answer: Sakhi responds, then asks the same thing again', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  assert.equal(t.task.id, 'q1_intro_followup');
  t = await answer(t.sessionId, 'But my name is not Riya. Why are you calling me Riya?');
  assert.equal(t.task.id, 'q1_intro_followup', 'still on the same question');
  const plan = t.trace.find((s) => s.step === 'plan' && s.discarded);
  assert.ok(plan, 'the prepared reply and scores were discarded');
  assert.match(mock.state.tutorPrompts.at(-1), /Instead of answering, the learner said something to you/);
  // Answering now moves on as normal.
  t = await answer(t.sessionId, 'I teach English and maths to small children every morning at the school.');
  assert.equal(t.task.id, 'q2_vocab');
});

test('"I would like to speak in Hindi" switches to Hindi for the rest of the conversation', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'Okay, uh, I would like to speak in Hindi.');
  assert.equal(t.task.id, 'q1_intro', 'not scored as the introduction');
  assert.equal(t.say[0].text, PHRASES.hindiOk);
  assert.equal(t.say[1].lang, 'hi-IN');
  t = await answer(t.sessionId, 'I usually work in a chakki, atta chakki, grinding wheat for people.');
  assert.equal(t.task.id, 'q1_intro_followup');
  assert.match(mock.state.tutorPrompts.at(-1), /LANGUAGE: The learner asked to talk in Hindi/);
});

test('Sakhi only uses the name the learner gave', async () => {
  mock.state.tutorMode = 'invent-name';
  try {
    let t = await post('/api/session', {});
    t = await answer(t.sessionId, 'I work in a shop near the station and I go home at night.');
    assert.doesNotMatch(t.say[0].text, /Riya/, 'an invented name is removed');
    assert.match(mock.state.tutorPrompts.at(-1), /Name: not known/);
    t = await answer(t.sessionId, 'My name is Prajwal and I sell tea and biscuits at the shop.');
    assert.match(mock.state.tutorPrompts.at(-1), /Name: not known/, 'learned while that line was written');
    t = await answer(t.sessionId, 'I do not know this one, sorry, can we go on please?');
    assert.match(mock.state.tutorPrompts.at(-1), /Name: Prajwal/, 'the name they said is remembered');
  } finally { mock.state.tutorMode = 'good'; }
});

test('half an answer to a two-part word task: Sakhi asks only for the missing part, then scores both together', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  t = await answer(t.sessionId, 'I teach English and maths to small children every morning at the school.');
  assert.equal(t.task.id, 'q2_vocab');
  const v = QUESTIONS[1].variants[t.task.level];
  const first = [v.expect[0]].flat()[0];
  t = await answer(t.sessionId, `This is ${first}.`, 2);
  assert.equal(t.task.id, 'q2_vocab', 'still on the word task');
  assert.ok(t.trace.some((s) => s.step === 'plan' && s.next === 'ask for the missing part'));
  assert.match(mock.state.tutorPrompts.at(-1), /answered only part of the task/);
  assert.ok(!t.trace.some((s) => s.step === 'judge'), 'half an answer is not scored yet');
  const second = [v.expect[1]].flat()[0];
  t = await answer(t.sessionId, `I think it is ${second}, that is my answer.`, 3);
  assert.equal(t.task.id, 'q3_read', 'moved on after the second part');
  const scores = t.trace.find((s) => s.step === 'features');
  assert.deepEqual(scores.vocabHits, [true, true], 'both replies were scored together');
});

test('a part they tried but got wrong is not asked again', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  t = await answer(t.sessionId, 'I teach English and maths to small children every morning at the school.');
  const v = QUESTIONS[1].variants[t.task.level];
  t = await answer(t.sessionId, `${[v.expect[0]].flat()[0]}. And ${v.parts[1].cues[0]}, I don't remember that one.`, 4);
  assert.equal(t.task.id, 'q3_read');
});

test('each turn reports what the conversation has cost; voice is charged to it, cached lines are free', async () => {
  let t = await post('/api/session', {});
  assert.equal(t.cost.totalInr, 0);
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  assert.ok(t.cost.llm.calls >= 3, 'understand, scoring and tutor calls are counted');
  assert.ok(t.cost.llm.byPurpose.understand && t.cost.llm.byPurpose.scoring && t.cost.llm.byPurpose.tutor);
  assert.ok(t.cost.totalInr > 0);
  // Speak a new line for this conversation, then a cached one.
  const tts = (text) => fetch(`${base}/api/tts/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang: 'en-IN', pace: 1, sessionId: t.sessionId }) }).then((r) => r.arrayBuffer());
  await tts(t.say[0].text); await tts(t.say[0].text);
  const c = await fetch(`${base}/api/session/cost?id=${t.sessionId}`).then((r) => r.json());
  assert.equal(c.tts.chars, t.say[0].text.length);
  assert.equal(c.tts.calls, 1);
  assert.equal(c.tts.cachedCalls, 1);
  assert.ok(c.totalInr > t.cost.totalInr);
  assert.equal((await fetch(`${base}/api/session/cost?id=nope`)).status, 404);
});
