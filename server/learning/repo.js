// Everything the learning module reads and writes in PostgreSQL. The learning module needs a database (the API
// answers 503 without one). Writes that belong together happen in one transaction.
import { pool } from '../db/pool.js';
import { skillFrom, estimateLevel, outcomeOf, LEVEL_RULES } from './progress.js';

export const enabled = () => !!pool;
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0] || null;

export async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}

// ---- learner profile and memory ------------------------------------------------------

/** The learner's profile (created on first use with the admin's default correction intensity). */
export async function profile(userId, defaultIntensity = 'balanced') {
  await q(`insert into learner_profiles (user_id, correction_intensity) values ($1, $2) on conflict (user_id) do nothing`, [userId, defaultIntensity]);
  const r = await one(`
    select p.*, u.name, u.attributes,
      (select level from assessments a where a.user_id = p.user_id and a.status = 'finished' and a.level is not null order by finished_at desc limit 1) as placement_level
    from learner_profiles p join users u on u.id = p.user_id where p.user_id = $1`, [userId]);
  return r && {
    userId, name: r.name, correctionIntensity: r.correction_intensity, goals: r.goals, supportLanguage: r.support_language,
    placementLevel: r.placement_level, level: r.estimated_level ?? r.placement_level ?? null,
    levelConfidence: r.level_confidence == null ? null : Number(r.level_confidence), levelUpdatedAt: r.level_updated_at,
    facts: Array.isArray(r.attributes?.conversation_facts) ? r.attributes.conversation_facts : [],
  };
}

export async function updatePreferences(userId, { correctionIntensity, goals, supportLanguage }) {
  await q(`update learner_profiles set correction_intensity = coalesce($2, correction_intensity), goals = coalesce($3, goals),
             support_language = case when $4::boolean then $5 else support_language end, updated_at = now() where user_id = $1`,
  [userId, correctionIntensity ?? null, goals ? JSON.stringify(goals) : null, supportLanguage !== undefined, supportLanguage ?? null]);
}

/** What the tutor should remember: mistakes the learner keeps making, and what was explained recently. */
export async function memory(userId) {
  const recurring = (await q(`select concept_key as concept, mistakes from learner_skills
      where user_id = $1 and status <> 'mastered' and mistakes >= 2 order by mistakes desc, last_seen_at desc limit 5`, [userId])).rows;
  const recentlyExplained = (await q(`select distinct c.concept_key from corrections c join messages m on m.id = c.message_id
      join conversations v on v.id = m.conversation_id
      where v.user_id = $1 and c.created_at > now() - interval '1 day' and c.concept_key is not null limit 8`, [userId])).rows.map((r) => r.concept_key);
  return { recurring, recentlyExplained };
}

// ---- conversations and messages ----------------------------------------------------------

export async function createConversation({ userId, mode = 'conversation', lessonSessionId = null, title = null }) {
  return one(`insert into conversations (user_id, mode, lesson_session_id, title) values ($1, $2, $3, $4) returning *`, [userId, mode, lessonSessionId, title]);
}

export const conversation = (id) => one('select * from conversations where id = $1', [id]);

export async function conversations(userId, limit = 20) {
  return (await q(`select c.*, (select content from messages m where m.conversation_id = c.id order by created_at desc limit 1) as last_message,
      (select count(*)::int from messages m where m.conversation_id = c.id) as message_count
    from conversations c where c.user_id = $1 order by last_message_at desc limit $2`, [userId, limit])).rows;
}

/** A conversation's messages, oldest first, with the corrections attached to each learner message. */
export async function messages(conversationId, { limit = 100, excludeId = null } = {}) {
  const rows = (await q(`select * from (select * from messages where conversation_id = $1 and ($3::uuid is null or id <> $3)
      order by created_at desc, id desc limit $2) m order by created_at, id`, [conversationId, limit, excludeId])).rows;
  if (!rows.length) return [];
  const corr = (await q('select * from corrections where message_id = any($1) order by created_at', [rows.map((r) => r.id)])).rows;
  return rows.map((m) => ({ ...m, corrections: corr.filter((c) => c.message_id === m.id) }));
}

export const learnerMessageByClientId = (conversationId, clientMessageId) => clientMessageId
  ? one(`select * from messages where conversation_id = $1 and client_message_id = $2 and role = 'learner'`, [conversationId, clientMessageId])
  : null;

/** Save the learner's message. → the row, or null if a request with the same client id got there first. */
export async function addLearnerMessage({ conversationId, content, channel, clientMessageId, metadata }) {
  return one(`insert into messages (conversation_id, role, content, channel, client_message_id, metadata) values ($1, 'learner', $2, $3, $4, $5)
      on conflict (conversation_id, client_message_id) where client_message_id is not null do nothing returning *`,
  [conversationId, content, channel, clientMessageId, metadata || {}]);
}

/** The stored reply to a learner message, with the corrections that were shown. */
export async function replyTo(learnerMessageId) {
  const reply = await one(`select * from messages where reply_to = $1 and role = 'tutor'`, [learnerMessageId]);
  if (!reply) return null;
  const corrections = (await q('select * from corrections where message_id = $1 order by created_at', [learnerMessageId])).rows;
  return { reply, corrections };
}

/** Learner messages in the last 24 hours (the daily limit). */
export const messagesToday = async (userId) => (await one(`select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id
    where c.user_id = $1 and m.role = 'learner' and m.created_at > now() - interval '1 day'`, [userId])).n;

/**
 * Save a tutor turn: the reply, the corrections shown, and the learning evidence, all at once. If a reply to the
 * same learner message was already saved (a doubled request), nothing is written. → { reply, corrections, duplicate }
 */
export async function saveTurn({ userId, conversationId, learnerMessage, turn, channel }) {
  return tx(async (c) => {
    const reply = (await c.query(`insert into messages (conversation_id, role, content, channel, reply_to, metadata) values ($1, 'tutor', $2, $3, $4, $5)
        on conflict (reply_to) where role = 'tutor' do nothing returning *`,
    [conversationId, turn.reply, channel, learnerMessage.id, { ...turn.meta, encouragement: turn.encouragement, followUpQuestion: turn.followUpQuestion, dropped: turn.dropped.map((d) => ({ original: d.correction.original, corrected: d.correction.corrected, reason: d.reason })) }])).rows[0];
    if (!reply) return { duplicate: true };
    const corrections = [];
    for (const k of turn.corrections) {
      corrections.push((await c.query(`insert into corrections (message_id, original, corrected, category, concept_key, explanation, severity, verified)
          values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`, [learnerMessage.id, k.original, k.corrected, k.category, k.concept, k.explanation, k.severity, turn.verified])).rows[0]);
    }
    const events = [
      ...turn.corrections.map((k) => ({ kind: 'mistake', concept: k.concept, category: k.category, detail: { original: k.original, corrected: k.corrected, severity: k.severity } })),
      ...turn.signals.map((s) => ({ kind: 'correct_use', concept: s.concept, category: null, detail: { evidence: s.evidence } })),
    ];
    await addEvents(c, userId, events, { messageId: learnerMessage.id });
    await c.query('update conversations set last_message_at = now() where id = $1', [conversationId]);
    return { reply, corrections, duplicate: false };
  });
}

// ---- learning evidence and progress -----------------------------------------------------------

/** Add raw evidence and recompute the skills it touches (inside the caller's transaction). */
export async function addEvents(c, userId, events, { messageId = null, exerciseAttemptId = null } = {}) {
  if (!events.length) return;
  for (const e of events) {
    await c.query(`insert into learning_events (user_id, kind, concept_key, category, detail, message_id, exercise_attempt_id) values ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, e.kind, e.concept || null, e.category || null, e.detail || {}, messageId, exerciseAttemptId]);
  }
  const concepts = [...new Set(events.map((e) => e.concept).filter(Boolean))];
  if (concepts.length) await recomputeSkills(c, userId, concepts);
}

/** learner_skills is derived: recomputed from the latest 50 pieces of evidence per concept. */
export async function recomputeSkills(c, userId, concepts) {
  const rows = (await c.query(`select concept_key, category, kind, detail from (
      select *, row_number() over (partition by concept_key order by id desc) as n from learning_events
      where user_id = $1 and concept_key = any($2) and kind in ('mistake', 'correct_use', 'exercise_attempt')) e
    where n <= 50 order by concept_key, id`, [userId, concepts])).rows;
  for (const concept of concepts) {
    const ev = rows.filter((r) => r.concept_key === concept);
    const outcomes = ev.map((r) => outcomeOf(r.kind, r.detail)).filter((o) => o != null);
    const s = skillFrom(outcomes);
    await c.query(`insert into learner_skills (user_id, concept_key, category, mistakes, correct_uses, mastery, status, last_seen_at)
        values ($1, $2, $3, $4, $5, $6, $7, now())
        on conflict (user_id, concept_key) do update set category = coalesce(excluded.category, learner_skills.category), mistakes = excluded.mistakes,
          correct_uses = excluded.correct_uses, mastery = excluded.mastery, status = excluded.status, last_seen_at = now()`,
    [userId, concept, ev.find((r) => r.category)?.category || null, s.mistakes, s.correct, s.mastery, s.status]);
  }
}

/** Re-estimate the learner's level from recent evidence (see progress.js). → the estimate */
export async function updateLevel(userId) {
  const p = await profile(userId);
  if (!p) return null;
  const outcomes = (await q(`select kind, detail from learning_events where user_id = $1 and kind in ('mistake', 'correct_use', 'exercise_attempt')
      and occurred_at > now() - make_interval(days => $2) order by id`, [userId, LEVEL_RULES.windowDays])).rows.map((r) => outcomeOf(r.kind, r.detail));
  const est = estimateLevel({ placementLevel: p.placementLevel, currentLevel: p.level, outcomes, lastChangedAt: p.levelUpdatedAt });
  await tx(async (c) => {
    await c.query(`update learner_profiles set estimated_level = $2, level_confidence = $3, level_updated_at = case when $4 then now() else level_updated_at end, updated_at = now() where user_id = $1`,
      [userId, est.level, est.confidence, est.changed]);
    if (est.changed) await c.query(`insert into level_history (user_id, level, source) values ($1, $2, 'practice')`, [userId, est.level]);
  });
  return est;
}

/** The learner's progress: skills, recent activity, level. */
export async function progress(userId) {
  const p = await profile(userId);
  const skills = (await q(`select concept_key as concept, category, mistakes, correct_uses as "correctUses", mastery::float as mastery, status, last_seen_at as "lastSeenAt"
      from learner_skills where user_id = $1 order by status, mastery`, [userId])).rows;
  const activity = await one(`select
      (select count(*)::int from messages m join conversations c on c.id = m.conversation_id where c.user_id = $1 and m.role = 'learner') as messages,
      (select count(*)::int from conversations where user_id = $1) as conversations,
      (select count(*)::int from lesson_sessions where user_id = $1 and status = 'completed') as "lessonsCompleted",
      (select count(*)::int from learning_events where user_id = $1 and kind = 'mistake' and occurred_at > now() - interval '7 days') as "mistakesThisWeek",
      (select count(*)::int from learning_events where user_id = $1 and kind = 'correct_use' and occurred_at > now() - interval '7 days') as "correctUsesThisWeek"`, [userId]);
  return {
    level: p.level, placementLevel: p.placementLevel, levelConfidence: p.levelConfidence,
    activity, skills,
    focus: skills.filter((s) => s.status !== 'mastered' && s.mistakes >= 2).sort((a, b) => b.mistakes - a.mistakes).slice(0, 3).map((s) => s.concept),
  };
}
