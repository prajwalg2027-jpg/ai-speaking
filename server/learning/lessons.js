// Lessons: explain → examples → exercises (each judged, with feedback) → next → record progress.
// Content comes from shared/lessons.json and is synced into the database at start (changed content = a new
// version; a session keeps the version it started with in lesson_version). Exact answers are marked without the AI;
// free answers, and other ways of giving the right answer, are judged by the AI (the "lessonEval" job).
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { structured as defaultStructured } from '../llm/index.js';
import { ExerciseEvaluation } from './schemas.js';
import { buildExerciseMessages } from './prompts.js';
import { tx, addEvents } from './repo.js';

const FILE = new URL('../../shared/lessons.json', import.meta.url);
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0] || null;
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const MAX_TRIES = 2; // a second try after a wrong answer, then the right answer is shown and the lesson moves on

/** Copy shared/lessons.json into the database. A lesson whose content changed gets a new version. → { added, updated } */
export async function sync(log = console.log) {
  if (!pool) return { added: 0, updated: 0 };
  const { lessons } = JSON.parse(await readFile(FILE, 'utf8'));
  let added = 0, updated = 0;
  await tx(async (c) => {
    for (const [i, l] of lessons.entries()) {
      const content = { summary: l.summary, explanation: l.explanation, examples: l.examples, concepts: l.concepts, exerciseCount: l.exercises.length };
      const hash = createHash('sha256').update(JSON.stringify([l.title, l.level, l.objective, l.category, content, l.exercises])).digest('hex').slice(0, 16);
      const old = (await c.query('select version, content->>\'hash\' as hash from lessons where id = $1', [l.id])).rows[0];
      if (old?.hash === hash) continue;
      await c.query(`insert into lessons (id, category, title, level, objective, content, version, active, position) values ($1, $2, $3, $4, $5, $6, 1, true, $7)
          on conflict (id) do update set category = excluded.category, title = excluded.title, level = excluded.level, objective = excluded.objective,
            content = excluded.content, version = lessons.version + 1, active = true, position = excluded.position, updated_at = now()`,
      [l.id, l.category, l.title, l.level, l.objective, { ...content, hash }, i]);
      for (const [j, e] of l.exercises.entries()) {
        await c.query(`insert into exercises (id, lesson_id, position, kind, prompt, accepted_answers, options, concept_key, explanation) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            on conflict (id) do update set kind = excluded.kind, prompt = excluded.prompt, accepted_answers = excluded.accepted_answers,
              options = excluded.options, concept_key = excluded.concept_key, explanation = excluded.explanation`,
        [`${l.id}/${j + 1}`, l.id, j + 1, e.kind, e.prompt, JSON.stringify(e.accepted || []), e.options ? JSON.stringify(e.options) : null, e.concept || l.concepts[0], e.explanation || null]);
      }
      if (old) updated++; else added++;
    }
    // Lessons removed from the file are switched off (kept for the sessions that used them).
    await c.query('update lessons set active = false where not (id = any($1))', [lessons.map((l) => l.id)]);
  });
  if (added || updated) log(`[learn] lessons: ${added} added, ${updated} updated`);
  return { added, updated };
}

/** Lower case, no punctuation, single spaces: what's compared for exact answers. */
export const normAnswer = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Mark an answer without the AI when possible. → { verdict, feedback } | null (needs the AI) */
export function exactMark(exercise, answer) {
  const accepted = exercise.accepted_answers || [];
  if (exercise.kind === 'choose') {
    const opts = exercise.options || [];
    const a = answer.trim();
    // "2" or "b" pick an option by number or letter.
    const byIndex = /^\d+$/.test(a) ? opts[Number(a) - 1] : /^[a-z]$/i.test(a) && opts.length > 1 ? opts[a.toLowerCase().charCodeAt(0) - 97] : null;
    const picked = opts.find((o) => normAnswer(o) === normAnswer(byIndex ?? a));
    if (!picked) return { verdict: 'incorrect', feedback: `Please choose one of the options: ${opts.join(' / ')}` , invalid: true };
    return accepted.some((x) => normAnswer(x) === normAnswer(picked))
      ? { verdict: 'correct', feedback: 'Correct!' }
      : { verdict: 'incorrect', feedback: `Not quite. The answer is "${accepted[0]}". ${exercise.explanation || ''}`.trim() };
  }
  if (!accepted.length) return null;
  const said = normAnswer(answer);
  const candidates = accepted.map(normAnswer);
  // A fill-in-the-blank answered with the whole sentence also counts.
  if (exercise.kind === 'fill_blank') for (const a of accepted) candidates.push(normAnswer(exercise.prompt.replace(/\s*\([^)]*\)/g, '').replace('___', a)));
  return candidates.includes(said) ? { verdict: 'correct', feedback: 'Correct!' } : null;
}

// ---- reading -------------------------------------------------------------------------------------

const lessonView = (l) => ({ id: l.id, category: l.category, title: l.title, level: l.level, objective: l.objective, version: l.version,
  summary: l.content.summary, explanation: l.content.explanation, examples: l.content.examples, exerciseCount: l.content.exerciseCount });
const exerciseView = (e) => e && ({ id: e.id, position: e.position, kind: e.kind, prompt: e.prompt, options: e.options || null });

/** The lessons, with how far the learner got in each. */
export async function list(userId) {
  const rows = (await q(`select l.*, s.id as session_id, s.status as session_status, s.current_position, s.correct_count,
        (select count(*)::int from lesson_sessions d where d.user_id = $1 and d.lesson_id = l.id and d.status = 'completed') as completed_times
      from lessons l left join lateral (select * from lesson_sessions s where s.user_id = $1 and s.lesson_id = l.id order by started_at desc limit 1) s on true
      where l.active order by l.level, l.position`, [userId])).rows;
  return rows.map((l) => ({ ...lessonView(l), progress: l.session_id ? { sessionId: l.session_id, status: l.session_status, position: l.current_position, correct: l.correct_count } : null, completedTimes: l.completed_times }));
}

export async function lesson(id) {
  const l = await one('select * from lessons where id = $1', [id]);
  return l && lessonView(l);
}

const exerciseAt = (lessonId, position) => one('select * from exercises where lesson_id = $1 and position = $2', [lessonId, position]);

/** For the tutor prompt in a lesson conversation: the lesson and the exercise the learner is on. */
export async function context(lessonSessionId) {
  const s = await one('select s.*, l.title, l.category, l.level, l.objective, l.content from lesson_sessions s join lessons l on l.id = s.lesson_id where s.id = $1', [lessonSessionId]);
  if (!s) return {};
  return { lesson: { title: s.title, category: s.category, level: s.level, objective: s.objective, content: s.content }, exercise: s.status === 'active' ? await exerciseAt(s.lesson_id, s.current_position) : null };
}

async function sessionState(s) {
  const l = await one('select * from lessons where id = $1', [s.lesson_id]);
  const conv = await one('select id from conversations where lesson_session_id = $1 order by started_at limit 1', [s.id]);
  return {
    sessionId: s.id, status: s.status, position: s.current_position, correct: s.correct_count, attempts: s.attempt_count,
    total: l.content.exerciseCount, conversationId: conv?.id || null,
    lesson: lessonView(l),
    exercise: s.status === 'active' ? exerciseView(await exerciseAt(s.lesson_id, s.current_position)) : null,
  };
}

/** Start a lesson (or carry on with the one in progress). → the lesson, the current exercise, a conversation for questions */
export async function start(userId, lessonId) {
  const l = await one('select * from lessons where id = $1 and active', [lessonId]);
  if (!l) throw fail(404, 'lesson not found');
  let s = await one(`select * from lesson_sessions where user_id = $1 and lesson_id = $2 and status = 'active' order by started_at desc limit 1`, [userId, lessonId]);
  if (!s) {
    s = await tx(async (c) => {
      const row = (await c.query('insert into lesson_sessions (user_id, lesson_id, lesson_version) values ($1, $2, $3) returning *', [userId, lessonId, l.version])).rows[0];
      await c.query(`insert into conversations (user_id, mode, lesson_session_id, title) values ($1, 'lesson', $2, $3)`, [userId, row.id, l.title]);
      return row;
    });
  }
  return sessionState(s);
}

export async function state(userId, sessionId) {
  const s = await one('select * from lesson_sessions where id = $1 and user_id = $2', [sessionId, userId]);
  if (!s) throw fail(404, 'lesson session not found');
  return sessionState(s);
}

export const AttemptInput = z.strictObject({
  exerciseId: z.string().min(1).max(100),
  answer: z.string().trim().min(1, 'answer is empty').max(600),
  channel: z.enum(['text', 'voice']).default('text'),
  clientAttemptId: z.string().trim().min(1).max(100).nullable().default(null),
});

/**
 * Answer the current exercise. Marked exactly when possible, otherwise by the AI. A wrong answer gets one more try;
 * then the right answer is shown and the lesson moves on. Safe to retry with the same clientAttemptId.
 * → { verdict, feedback, corrections, tryAgain, answer?, state, summary? }
 */
export async function attempt(userId, sessionId, input, { structured = defaultStructured } = {}) {
  const p = AttemptInput.safeParse(input);
  if (!p.success) throw fail(400, p.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  const { exerciseId, answer, channel, clientAttemptId } = p.data;
  let s = await one('select * from lesson_sessions where id = $1 and user_id = $2', [sessionId, userId]);
  if (!s) throw fail(404, 'lesson session not found');

  if (clientAttemptId) {
    const prev = await one('select * from exercise_attempts where lesson_session_id = $1 and client_attempt_id = $2', [sessionId, clientAttemptId]);
    if (prev) return { ...JSON.parse(prev.feedback), replayed: true, state: await sessionState(s) };
  }
  if (s.status !== 'active') throw fail(409, 'this lesson is already finished');
  const ex = await exerciseAt(s.lesson_id, s.current_position);
  if (!ex || ex.id !== exerciseId) throw fail(409, 'that is not the current exercise', { state: await sessionState(s) });

  let mark = exactMark(ex, answer), corrections = [], via = 'exact';
  if (mark?.invalid) return { verdict: null, feedback: mark.feedback, corrections: [], tryAgain: true, state: await sessionState(s) };
  if (!mark) {
    const l = await one('select * from lessons where id = $1', [s.lesson_id]);
    try {
      const r = await structured({ job: 'lessonEval', messages: buildExerciseMessages({ lesson: l, exercise: ex, answer, channel }), schema: ExerciseEvaluation, schemaName: 'exercise_evaluation', maxTokens: 500 });
      mark = { verdict: r.data.verdict, feedback: r.data.feedback };
      corrections = r.data.corrections.filter((c) => normAnswer(answer).includes(normAnswer(c.original)) && normAnswer(c.original) !== normAnswer(c.corrected));
      via = `${r.provider}:${r.model}`;
    } catch (e) {
      console.warn(`[learn] exercise evaluation failed: ${e.message}`);
      throw fail(502, 'could not check that answer', { reason: 'Sorry, I could not check that just now. Please send it again.' });
    }
  }

  const tries = (await one('select count(*)::int as n from exercise_attempts where lesson_session_id = $1 and exercise_id = $2', [sessionId, ex.id])).n + 1;
  const moveOn = mark.verdict === 'correct' || tries >= MAX_TRIES;
  const isLast = s.current_position >= (await one('select count(*)::int as n from exercises where lesson_id = $1', [s.lesson_id])).n;
  const out = {
    verdict: mark.verdict, feedback: mark.feedback, corrections, tryAgain: !moveOn,
    answer: moveOn && mark.verdict !== 'correct' && ex.accepted_answers?.length ? ex.accepted_answers[0] : null,
    explanation: moveOn && mark.verdict !== 'correct' ? ex.explanation : null,
    markedBy: via,
  };

  s = await tx(async (c) => {
    const a = (await c.query(`insert into exercise_attempts (lesson_session_id, exercise_id, user_id, answer, verdict, feedback, client_attempt_id) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (lesson_session_id, client_attempt_id) where client_attempt_id is not null do nothing returning id`,
    [sessionId, ex.id, userId, answer, mark.verdict, JSON.stringify(out), clientAttemptId])).rows[0];
    if (!a) return null; // a doubled request saved it first
    await addEvents(c, userId, [{ kind: 'exercise_attempt', concept: ex.concept_key, category: null, detail: { verdict: mark.verdict, lessonId: s.lesson_id, exerciseId: ex.id, try: tries } }], { exerciseAttemptId: a.id });
    const done = moveOn && isLast;
    const row = (await c.query(`update lesson_sessions set attempt_count = attempt_count + 1, correct_count = correct_count + $2,
          current_position = current_position + $3, status = case when $4 then 'completed' else status end, completed_at = case when $4 then now() else completed_at end
        where id = $1 returning *`, [sessionId, mark.verdict === 'correct' ? 1 : 0, moveOn && !isLast ? 1 : 0, done])).rows[0];
    if (done) await addEvents(c, userId, [{ kind: 'lesson_completed', concept: null, detail: { lessonId: s.lesson_id, correct: row.correct_count, total: row.current_position } }]);
    return row;
  });
  if (!s) {
    const prev = await one('select * from exercise_attempts where lesson_session_id = $1 and client_attempt_id = $2', [sessionId, clientAttemptId]);
    return { ...JSON.parse(prev.feedback), replayed: true, state: await state(userId, sessionId) };
  }
  const st = await sessionState(s);
  return { ...out, state: st, summary: s.status === 'completed' ? { correct: s.correct_count, total: st.total } : null };
}
