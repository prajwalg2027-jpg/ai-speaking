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

test('word tasks ask one word at a time, then score both replies together', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  t = await answer(t.sessionId, 'I teach English and maths to small children every morning at the school.');
  assert.equal(t.task.id, 'q2_vocab');
  const v = QUESTIONS[1].variants[t.task.level];
  assert.equal(t.card.text, v.screen, 'the card shows only the first word');
  t = await answer(t.sessionId, `This is ${[v.expect[0]].flat()[0]}.`, 2);
  assert.equal(t.task.id, 'q2_vocab', 'still on the word task');
  assert.equal(t.card.text, v.second.screen, 'the card now shows the second word');
  assert.ok(t.trace.some((s) => s.step === 'plan' && s.next === 'ask the second word on its own'));
  assert.ok(!t.trace.some((s) => s.step === 'judge'), 'not scored until both are answered');
  t = await answer(t.sessionId, `I think it is ${[v.expect[1]].flat()[0]}.`, 3);
  assert.equal(t.task.id, 'q3_read');
  assert.deepEqual(t.trace.find((s) => s.step === 'features').vocabHits, [true, true], 'both replies scored together');
});

test('"I don\'t know" to the first word still asks the second; both words at once skips it', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  t = await answer(t.sessionId, 'I teach English and maths to small children every morning at the school.');
  const v = QUESTIONS[1].variants[t.task.level];
  t = await answer(t.sessionId, "I don't know", 1);
  assert.equal(t.task.id, 'q2_vocab');
  assert.equal(t.card.text, v.second.screen);

  t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  t = await answer(t.sessionId, 'I teach English and maths to small children every morning at the school.');
  const w = QUESTIONS[1].variants[t.task.level];
  t = await answer(t.sessionId, `${[w.expect[0]].flat()[0]}, and the other one is ${[w.expect[1]].flat()[0]}.`, 4);
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

test('"speak in Punjabi" switches Sakhi to Punjabi (voice too); "speak in English" switches back', async () => {
  let t = await post('/api/session', {});
  let from = mock.state.tutorPrompts.length;
  t = await answer(t.sessionId, 'Can you speak in Punjabi please?');
  assert.equal(t.task.id, 'q1_intro', 'not scored');
  assert.equal(t.say[0].lang, 'pa-IN');
  assert.ok(mock.state.tutorPrompts.slice(from).some((x) => /talk in Punjabi/.test(x)));
  t = await answer(t.sessionId, 'I am a farmer and I grow wheat and sugarcane in my village near Ludhiana.');
  assert.equal(t.task.id, 'q1_intro_followup');
  assert.equal(t.say[0].lang, 'pa-IN', 'stays in Punjabi');
  t = await answer(t.sessionId, 'Okay, now speak in English please.');
  assert.equal(t.say[0].lang, 'en-IN');
  assert.ok(t.trace.some((s) => s.step === 'plan' && s.next === 'talk in English from now on'));
  from = mock.state.tutorPrompts.length;
  t = await answer(t.sessionId, 'We start work at six in the morning and finish when the sun goes down.');
  assert.ok(!mock.state.tutorPrompts.slice(from).some((x) => /talk in Punjabi/.test(x)));
});

test('a line in the wrong language is retried once, then replaced', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'Can you speak in Tamil please?'); // the mock tutor only writes English
  const steps = t.trace.map((s) => s.step);
  assert.ok(steps.includes('tutor-retry'));
  assert.equal(t.trace.find((s) => s.step === 'tutor-fallback').reason, 'not in Tamil');
});

// ---- interruptions -------------------------------------------------------------------------------------

test('talking over Sakhi before her question: memory keeps only what was heard, and the reply is not scored', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher and I love walking in the evening with friends near my house in Pune.');
  assert.equal(t.task.id, 'q1_intro_followup');
  const said = t.say[0].text; // reaction, then the follow-up question
  t = await post('/api/session/turn', { sessionId: t.sessionId, event: 'answer', transcript: 'Yes it is really nice there.', speechSec: 3, interrupted: { index: 0, heardSec: 0.05 } });
  const cut = t.trace.find((s) => s.step === 'interrupted');
  assert.ok(cut && !cut.askHeard && said.startsWith(cut.heard));
  assert.ok(t.trace.some((s) => s.step === 'plan' && s.next === 'respond, then ask the question' && s.discarded), 'not scored');
  assert.equal(t.task.id, 'q1_intro_followup', 'same question, asked properly');
  assert.match(mock.state.tutorPrompts.at(-1), /\[the learner talked over Sakhi here\]/);
});

test('talking over Sakhi to finish the previous answer: the two are joined and scored as one', async () => {
  let t = await post('/api/session', {});
  t = await answer(t.sessionId, 'I am a teacher in a small school.');
  assert.equal(t.task.id, 'q1_intro_followup');
  t = await post('/api/session/turn', { sessionId: t.sessionId, event: 'answer', transcript: 'and also I teach music to children on weekends.', speechSec: 3, interrupted: { index: 0, heardSec: 0.6 } });
  assert.ok(t.trace.some((s) => s.step === 'plan' && s.next === 'join it to their previous answer'));
  const q = t.trace.find((s) => s.step === 'question');
  assert.equal(q.id, 'q1_intro', 'back on the introduction');
  assert.equal(q.transcript, 'I am a teacher in a small school. and also I teach music to children on weekends.');
  assert.equal(t.task.id, 'q1_intro_followup');
});

test('talking over the closing summary to finish the last answer reopens it, then closes again', async () => {
  let t = await post('/api/session', {});
  for (let i = 0; i < 20 && !t.done; i++) {
    const reply = t.task.kind === 'read' ? t.card.text : t.task.kind === 'vocab' ? 'Responsibility. And a deadline is the last date to finish a task.' : 'I work as a teacher in a small school near Pune and I walk with friends in the evening.';
    t = await answer(t.sessionId, reply, 6);
  }
  assert.ok(t.done);
  t = await post('/api/session/turn', { sessionId: t.sessionId, event: 'answer', transcript: 'and also we go to the movies sometimes.', speechSec: 2, interrupted: { index: 0, heardSec: 0.5 } });
  assert.ok(t.trace.some((s) => s.step === 'plan' && s.next === 'join it to their previous answer'));
  assert.ok(t.done, 'a new summary');
  assert.match(t.done.answers.at(-1).transcript, /movies/);
});
