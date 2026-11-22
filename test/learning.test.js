// The learning module against a real PostgreSQL (TEST_DATABASE_URL; skipped without it), with a mocked AI:
// conversations, safe retries, corrections and evidence, progress, lessons.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
let pool, store, repo, lessons, createRuntime, settings;
before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  const { migrate } = await import('../server/db/migrate.js');
  await migrate(pool, () => {});
  store = await import('../server/store.js');
  repo = await import('../server/learning/repo.js');
  lessons = await import('../server/learning/lessons.js');
  settings = await import('../server/settings.js');
  ({ createRuntime } = await import('../server/learning/runtime.js'));
  await lessons.sync(() => {});
});
after(async () => { await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

const corr = (original, corrected, extra = {}) => ({ original, corrected, category: 'grammar', concept: 'past_simple', explanation: 'Yesterday is finished: use the past.', severity: 'important', ...extra });
/** A mocked AI: answers by job, counts calls. */
function mockAi(answers) {
  const calls = [];
  const structured = async ({ job, schema }) => {
    calls.push(job);
    const a = answers[job];
    if (a instanceof Error) throw a;
    return { data: schema.parse(typeof a === 'function' ? a() : a), provider: 'mock', model: 'mock-1', latencyMs: 3, usage: { input: 800, output: 80 }, attempts: 1 };
  };
  return { structured, calls };
}
const tutor = (corrections = [], signals = []) => ({ reply: 'Lovely! What did you buy there?', corrections, encouragement: 'Good effort!', follow_up_question: 'What did you buy there?', learning_signals: signals });

let user, other;
t('setup: two learners', async () => {
  user = await store.upsertUser({ firebaseUid: 'learn-1', phone: '+919800001001' });
  other = await store.upsertUser({ firebaseUid: 'learn-2', phone: '+919800001002' });
  await settings.set('corrections', { ...settings.SECTIONS.corrections.defaults, strategy: 'verify' }, 'test');
});

t('a message gets a reply and checked corrections, saved with the evidence', async () => {
  const ai = mockAi({ tutor: tutor([corr('I go', 'I went'), corr('to market', 'to the market', { concept: 'articles', severity: 'moderate' })]), verify: { decisions: [{ index: 0, original: '', verdict: 'real_mistake', reason: 'ok' }, { index: 1, original: '', verdict: 'real_mistake', reason: 'ok' }] } });
  const rt = createRuntime({ structured: ai.structured });
  const conv = await repo.createConversation({ userId: user.id });
  const replies = [];
  const r = await rt.respond({ userId: user.id, conversationId: conv.id, message: 'Yesterday I go to market', clientMessageId: 'm1' }, { onReply: (x) => replies.push(x.reply) });
  assert.deepEqual(ai.calls, ['tutor', 'verify']);
  assert.deepEqual(replies, ['Lovely! What did you buy there?']);
  assert.equal(r.reply.text, 'Lovely! What did you buy there?');
  assert.equal(r.reply.encouragement, 'Good effort!');
  assert.deepEqual(r.corrections.map((c) => c.corrected), ['I went', 'to the market']);
  assert.equal(r.replayed, false);
  assert.equal(r.meta.strategy, 'verify');
  const rows = await repo.messages(conv.id);
  assert.deepEqual(rows.map((m) => m.role), ['learner', 'tutor']);
  assert.equal(rows[0].corrections.length, 2);
  assert.equal(rows[0].corrections[0].verified, true);
  assert.match(rows[1].metadata.promptVersion, /^tutor-v/);
  const ev = (await pool.query(`select kind, concept_key from learning_events where user_id = $1 order by id`, [user.id])).rows;
  assert.deepEqual(ev.map((e) => [e.kind, e.concept_key]), [['mistake', 'past_simple'], ['mistake', 'articles']]);
  const skill = await one(`select * from learner_skills where user_id = $1 and concept_key = 'past_simple'`, [user.id]);
  assert.equal(skill.mistakes, 1);
  assert.equal(skill.status, 'learning');
});

t('sending the same message again returns the stored answer, without calling the AI or saving twice', async () => {
  const ai = mockAi({ tutor: tutor(), verify: { decisions: [] } });
  const rt = createRuntime({ structured: ai.structured });
  const conv = (await repo.conversations(user.id))[0];
  const r = await rt.respond({ userId: user.id, conversationId: conv.id, message: 'Yesterday I go to market', clientMessageId: 'm1' });
  assert.equal(r.replayed, true);
  assert.deepEqual(ai.calls, []);
  assert.equal(r.corrections.length, 2);
  assert.equal((await one('select count(*)::int as n from messages where conversation_id = $1', [conv.id])).n, 2);
  assert.equal((await one('select count(*)::int as n from learning_events where user_id = $1', [user.id])).n, 2);
});

t('if the AI fails, the message is kept and a retry carries on from there', async () => {
  const conv = await repo.createConversation({ userId: user.id });
  const broken = createRuntime({ structured: mockAi({ tutor: Object.assign(new Error('timeout'), { kind: 'timeout' }) }).structured });
  await assert.rejects(broken.respond({ userId: user.id, conversationId: conv.id, message: 'I like cricket', clientMessageId: 'm2' }), (e) => e.status === 502 && /lost my train/.test(e.reason));
  assert.equal((await one('select count(*)::int as n from messages where conversation_id = $1', [conv.id])).n, 1, 'the learner message is saved');
  const ok = mockAi({ tutor: tutor([], [{ kind: 'correct_use', concept: 'present_simple', evidence: 'I like cricket' }]), verify: { decisions: [] } });
  const r = await createRuntime({ structured: ok.structured }).respond({ userId: user.id, conversationId: conv.id, message: 'I like cricket', clientMessageId: 'm2' });
  assert.equal(r.replayed, false);
  assert.equal((await one('select count(*)::int as n from messages where conversation_id = $1', [conv.id])).n, 2, 'one learner message, one reply');
  assert.equal((await one(`select count(*)::int as n from learning_events where user_id = $1 and kind = 'correct_use'`, [user.id])).n, 1);
});

t('two identical requests at once save only one reply', async () => {
  const conv = await repo.createConversation({ userId: user.id });
  const rt = createRuntime({ structured: mockAi({ tutor: tutor([corr('I go', 'I went')]), verify: { decisions: [{ index: 0, original: '', verdict: 'real_mistake', reason: 'ok' }] } }).structured });
  const results = await Promise.allSettled([1, 2].map(() => rt.respond({ userId: user.id, conversationId: conv.id, message: 'Yesterday I go home', clientMessageId: 'same' })));
  assert.ok(results.some((x) => x.status === 'fulfilled'));
  for (const x of results) if (x.status === 'rejected') assert.equal(x.reason.status, 409);
  assert.equal((await one(`select count(*)::int as n from messages where conversation_id = $1 and role = 'tutor'`, [conv.id])).n, 1);
  assert.equal((await one(`select count(*)::int as n from corrections c join messages m on m.id = c.message_id where m.conversation_id = $1`, [conv.id])).n, 1);
});

t('a learner can only use their own conversations, and input is checked', async () => {
  const rt = createRuntime({ structured: mockAi({}).structured });
  const conv = (await repo.conversations(user.id))[0];
  await assert.rejects(rt.respond({ userId: other.id, conversationId: conv.id, message: 'hi' }), (e) => e.status === 404);
  await assert.rejects(rt.respond({ userId: user.id, conversationId: conv.id, message: '   ' }), (e) => e.status === 400 && /empty/.test(e.message));
  await assert.rejects(rt.respond({ userId: user.id, conversationId: conv.id, message: 'x'.repeat(1001) }), (e) => e.status === 400);
});

t('memory: repeated mistakes and recent explanations reach the next prompt', async () => {
  let seen;
  const structured = async ({ job, schema, messages }) => { if (job === 'tutor') seen = messages[0].content; return { data: schema.parse(job === 'tutor' ? tutor() : { decisions: [] }), provider: 'mock', model: 'm', latencyMs: 1, usage: {}, attempts: 1 }; };
  const conv = await repo.createConversation({ userId: user.id });
  await createRuntime({ structured }).respond({ userId: user.id, conversationId: conv.id, message: 'Hello' });
  assert.match(seen, /Mistakes they often repeat: past_simple \(2×\)/);
  assert.match(seen, /Already explained recently.*past_simple/);
});

t('preferences change how strictly the learner is corrected', async () => {
  await repo.updatePreferences(user.id, { correctionIntensity: 'gentle', goals: ['job interview'] });
  let seen;
  const structured = async ({ job, schema, messages }) => { if (job === 'tutor') seen = messages[0].content; return { data: schema.parse(job === 'tutor' ? tutor([corr('I go', 'I went', { severity: 'moderate' })]) : { decisions: [{ index: 0, original: '', verdict: 'real_mistake', reason: '' }] }), provider: 'mock', model: 'm', latencyMs: 1, usage: {}, attempts: 1 }; };
  const conv = await repo.createConversation({ userId: user.id });
  const r = await createRuntime({ structured }).respond({ userId: user.id, conversationId: conv.id, message: 'Yesterday I go out' });
  assert.match(seen, /GENTLE/);
  assert.match(seen, /job interview/);
  assert.equal(r.corrections.length, 0, 'gentle shows only important mistakes');
  await repo.updatePreferences(user.id, { correctionIntensity: 'balanced' });
});

t('the daily limit stops new messages but not retries', async () => {
  await settings.set('limits', { ...settings.get('limits'), learnMessagesPerDay: 10 }, 'test');
  const conv = await repo.createConversation({ userId: other.id });
  const rt = createRuntime({ structured: mockAi({ tutor: tutor(), verify: { decisions: [] } }).structured });
  for (let i = 0; i < 10; i++) await rt.respond({ userId: other.id, conversationId: conv.id, message: `message ${i}`, clientMessageId: `d${i}` });
  await assert.rejects(rt.respond({ userId: other.id, conversationId: conv.id, message: 'one more', clientMessageId: 'd10' }), (e) => e.status === 429);
  assert.equal((await rt.respond({ userId: other.id, conversationId: conv.id, message: 'message 3', clientMessageId: 'd3' })).replayed, true);
  await settings.reset('limits', 'test');
});

t('lessons: synced from the file, started, answered, retried and finished', async () => {
  const list = await lessons.list(user.id);
  assert.ok(list.length >= 8);
  assert.equal((await lessons.sync(() => {})).updated, 0, 'unchanged content keeps its version');
  const st = await lessons.start(user.id, 'prepositions-time');
  assert.equal(st.exercise.position, 1);
  assert.ok(st.conversationId, 'a conversation for questions about the lesson');
  assert.deepEqual((await lessons.start(user.id, 'prepositions-time')).sessionId, st.sessionId, 'starting again carries on');

  const noAi = { structured: async () => { throw new Error('the AI should not be needed'); } };
  // 1: right first time (exact).
  let r = await lessons.attempt(user.id, st.sessionId, { exerciseId: st.exercise.id, answer: 'at', clientAttemptId: 'a1' }, noAi);
  assert.equal(r.verdict, 'correct');
  assert.equal(r.state.position, 2);
  // Retry of the same attempt: the stored result, nothing new.
  const again = await lessons.attempt(user.id, st.sessionId, { exerciseId: st.exercise.id, answer: 'at', clientAttemptId: 'a1' }, noAi);
  assert.equal(again.replayed, true);
  assert.equal((await one('select attempt_count from lesson_sessions where id = $1', [st.sessionId])).attempt_count, 1);
  // 2: a wrong answer the AI judges → one more try, then the answer is shown.
  const judge = (verdict) => ({ structured: mockAi({ lessonEval: { verdict, feedback: verdict === 'correct' ? 'Yes!' : 'Use on for days.', corrections: [] } }).structured });
  r = await lessons.attempt(user.id, st.sessionId, { exerciseId: r.state.exercise.id, answer: 'in', clientAttemptId: 'a2' }, judge('incorrect'));
  assert.equal(r.tryAgain, true);
  assert.equal(r.state.position, 2);
  r = await lessons.attempt(user.id, st.sessionId, { exerciseId: r.state.exercise.id, answer: 'at', clientAttemptId: 'a3' }, judge('incorrect'));
  assert.equal(r.tryAgain, false);
  assert.equal(r.answer, 'on');
  assert.equal(r.state.position, 3);
  // A stale exercise id is refused.
  await assert.rejects(lessons.attempt(user.id, st.sessionId, { exerciseId: 'prepositions-time/1', answer: 'at' }, noAi), (e) => e.status === 409);
  // 3, 4, 5.
  r = await lessons.attempt(user.id, st.sessionId, { exerciseId: r.state.exercise.id, answer: 'in' }, noAi);
  r = await lessons.attempt(user.id, st.sessionId, { exerciseId: r.state.exercise.id, answer: '2' }, noAi);
  assert.equal(r.verdict, 'correct', 'option 2 by number');
  r = await lessons.attempt(user.id, st.sessionId, { exerciseId: r.state.exercise.id, answer: 'On Saturday I will meet my friends at 6.' }, judge('correct'));
  assert.equal(r.state.status, 'completed');
  assert.deepEqual(r.summary, { correct: 4, total: 5 });
  const ev = (await pool.query(`select kind from learning_events where user_id = $1 and (kind = 'exercise_attempt' or kind = 'lesson_completed')`, [user.id])).rows;
  assert.equal(ev.filter((e) => e.kind === 'exercise_attempt').length, 6);
  assert.equal(ev.filter((e) => e.kind === 'lesson_completed').length, 1);
  assert.equal((await lessons.list(user.id)).find((l) => l.id === 'prepositions-time').completedTimes, 1);
});

t('a lesson conversation knows the lesson', async () => {
  const st = await lessons.start(user.id, 'articles-a-an-the');
  let seen;
  const structured = async ({ job, schema, messages }) => { seen = messages[0].content; return { data: schema.parse(job === 'tutor' ? tutor() : { decisions: [] }), provider: 'mock', model: 'm', latencyMs: 1, usage: {}, attempts: 1 }; };
  await createRuntime({ structured }).respond({ userId: user.id, conversationId: st.conversationId, message: 'Why an hour and not a hour?' });
  assert.match(seen, /Mode: a lesson/);
  assert.match(seen, /A, an and the/);
  assert.match(seen, /Current exercise: I ate ___ apple/);
});

t('progress: skills, focus areas and the level estimate', async () => {
  const p = await repo.progress(user.id);
  assert.ok(p.activity.messages >= 5);
  assert.equal(p.activity.lessonsCompleted, 1);
  assert.ok(p.skills.some((s) => s.concept === 'past_simple' && s.mistakes >= 2));
  assert.ok(p.focus.includes('past_simple'));
  assert.equal(p.level, null, 'no placement test yet');
});

t('erasing a learner removes their learning data too', async () => {
  await store.eraseUser(other.id, async () => {});
  assert.equal((await one('select count(*)::int as n from conversations where user_id = $1', [other.id])).n, 0);
  assert.equal((await one('select count(*)::int as n from learning_events where user_id = $1', [other.id])).n, 0);
});
