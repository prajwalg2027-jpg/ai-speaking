// Everything the server stores about customers (schema: server/db/migrations). Each function is a no-op when
// there's no database (development without DATABASE_URL), so the conversation never depends on it.
import { createHash } from 'node:crypto';
import { pool } from './db/pool.js';

export const enabled = () => !!pool;
const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}

// ---- customers ------------------------------------------------------------------

/**
 * The customer for a login (created on first sign-in): found by login id, or else by phone number, so a person
 * who signed in with Firebase and later with an OTP (or the other way round) stays one customer.
 */
export async function upsertUser({ firebaseUid, phone }) {
  if (!pool) return null;
  const found = (await q(
    `update users set last_seen_at = now(), phone = case when firebase_uid = $1 then coalesce($2, phone) else phone end where id = (select id from users where firebase_uid = $1 or ($2::text is not null and phone = $2)
       order by (firebase_uid = $1) desc limit 1) returning *, false as created`, [firebaseUid, phone || null])).rows[0];
  if (found) return found;
  const { rows } = await q(
    `insert into users (firebase_uid, phone, last_seen_at) values ($1, $2, now())
     on conflict (firebase_uid) do update set phone = coalesce(excluded.phone, users.phone), last_seen_at = now()
     returning *, (xmax = 0) as created`, [firebaseUid, phone || null]);
  return rows[0];
}

export async function getUser(id) {
  if (!pool || !id) return null;
  return (await q('select * from users where id = $1', [id])).rows[0] || null;
}

// ---- properties -----------------------------------------------------------------

const TYPE_OK = {
  string: (v) => typeof v === 'string' && v.length <= 500,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  date: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  list: (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length <= 300),
};

/**
 * Set properties: { key: value } (null removes one). Only keys in attribute_definitions, with the right type.
 * Only real changes are written, each with its old value, new value and source. → { changed: [keys] }
 */
export async function setAttributes(userId, changes, source) {
  if (!pool || !userId) return { changed: [] };
  return tx(async (c) => {
    const defs = Object.fromEntries((await c.query('select key, type from attribute_definitions where key = any($1)', [Object.keys(changes)])).rows.map((d) => [d.key, d.type]));
    for (const [k, v] of Object.entries(changes)) {
      if (!defs[k]) throw Object.assign(new Error(`unknown property: ${k}`), { status: 400 });
      if (v !== null && !TYPE_OK[defs[k]](v)) throw Object.assign(new Error(`property ${k} must be a ${defs[k]}`), { status: 400 });
    }
    const { rows: [u] } = await c.query('select attributes from users where id = $1 for update', [userId]);
    if (!u) return { changed: [] };
    const next = { ...u.attributes }, changed = [];
    for (const [k, v] of Object.entries(changes)) {
      const old = u.attributes[k] ?? null;
      if (JSON.stringify(old) === JSON.stringify(v)) continue;
      if (v === null) delete next[k]; else next[k] = v;
      changed.push(k);
      await c.query('insert into attribute_history (user_id, key, old_value, new_value, source) values ($1, $2, $3, $4, $5)',
        [userId, k, JSON.stringify(old), JSON.stringify(v), source]);
    }
    if (changed.length) {
      await c.query(`update users set attributes = $2, name = coalesce($3, name), updated_at = now() where id = $1`,
        [userId, next, changed.includes('name') ? next.name ?? null : null]);
    }
    return { changed };
  });
}

/** Conversation facts are added to the list (not replaced), keeping the latest 50. */
export async function addConversationFacts(userId, facts) {
  if (!pool || !userId || !facts?.length) return;
  const u = await getUser(userId);
  const list = [...(u?.attributes?.conversation_facts || [])];
  for (const f of facts) if (typeof f === 'string' && f.trim() && !list.includes(f.trim())) list.push(f.trim().slice(0, 300));
  await setAttributes(userId, { conversation_facts: list.slice(-50) }, 'conversation');
}

// ---- consents -------------------------------------------------------------------

/** Required before a first test: terms, privacy, 18 or older, and keeping voice recordings. */
export const REQUIRED_CONSENTS = ['terms', 'privacy', 'age_18_plus', 'recordings'];

export async function addConsents(userId, list) {
  if (!pool || !userId) return;
  await tx(async (c) => {
    for (const { purpose, version, granted } of list) {
      await c.query('insert into consents (user_id, purpose, version, granted) values ($1, $2, $3, $4)', [userId, purpose, String(version), !!granted]);
      if (purpose === 'age_18_plus' && granted) await c.query('update users set age_confirmed_at = now() where id = $1 and age_confirmed_at is null', [userId]);
    }
  });
}

/** The latest answer for each purpose. → { terms: true, recordings: false, … } */
export async function currentConsents(userId) {
  if (!pool || !userId) return {};
  const { rows } = await q(`select distinct on (purpose) purpose, granted from consents where user_id = $1 order by purpose, created_at desc, id desc`, [userId]);
  return Object.fromEntries(rows.map((r) => [r.purpose, r.granted]));
}

export async function missingConsents(userId) {
  const now = await currentConsents(userId);
  return REQUIRED_CONSENTS.filter((p) => now[p] !== true);
}

// ---- placement tests ------------------------------------------------------------

export async function startAssessment({ userId, sessionId, client, appVersion, scoringConfig }) {
  if (!pool) return null;
  const { rows } = await q(`insert into assessments (user_id, session_id, client, app_version, scoring_config) values ($1, $2, $3, $4, $5) returning id`,
    [userId || null, sessionId, client || null, appVersion || null, scoringConfig || null]);
  return rows[0].id;
}

/** One answer, as it happens. → the answer's id */
export async function saveAnswer(sessionId, a) {
  if (!pool) return null;
  const { rows } = await q(
    `insert into assessment_answers (assessment_id, seq, question_id, item_id, kind, variant_level, transcript, language, scores, features, needed_hindi, skipped)
     select id, coalesce((select max(seq) from assessment_answers where assessment_id = a.id), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     from assessments a where session_id = $1 returning id`,
    [sessionId, a.questionId, a.itemId || null, a.kind || null, a.variantLevel ?? null, a.transcript || null, a.languageCode || null,
      a.scores ? JSON.stringify(a.scores) : null, a.features ? JSON.stringify(a.features) : null, !!a.neededHindi, !!a.skipped]);
  return rows[0]?.id || null;
}

/** The result: the test, the level history, the current_level property, and an event. */
export async function finishAssessment(sessionId, result, costInr) {
  if (!pool) return;
  await tx(async (c) => {
    const { rows: [a] } = await c.query(
      `update assessments set status = 'finished', finished_at = now(), level = $2, level_name = $3, overall = $4, dims = $5, reasons = $6, cost_inr = $7
       where session_id = $1 returning id, user_id`,
      [sessionId, result.level, result.name, result.overall ?? null, JSON.stringify(result.dims || {}), JSON.stringify(result.reasons || []), costInr ?? null]);
    if (!a?.user_id) return;
    await c.query(`insert into level_history (user_id, level, source, assessment_id) values ($1, $2, 'placement', $3)`, [a.user_id, result.level, a.id]);
    await c.query(`insert into events (user_id, name, source, properties, session_id) values ($1, 'level.reached', 'server', $2, $3)`,
      [a.user_id, JSON.stringify({ level: result.level, via: 'placement', assessmentId: a.id }), sessionId]);
  });
  const { rows: [a] } = await q('select user_id from assessments where session_id = $1', [sessionId]);
  if (a?.user_id) await setAttributes(a.user_id, { current_level: result.level }, 'assessment');
}

// ---- events ---------------------------------------------------------------------

/** Log one event. A repeated client_event_id from the same customer is ignored. */
export async function addEvent({ userId, name, source = 'server', properties = {}, sessionId, clientEventId, occurredAt }) {
  if (!pool) return;
  await q(`insert into events (user_id, name, source, properties, session_id, client_event_id, occurred_at)
           values ($1, $2, $3, $4, $5, $6, coalesce($7, now())) on conflict do nothing`,
    [userId || null, name, source, JSON.stringify(properties), sessionId || null, clientEventId || null, occurredAt || null]);
}

// ---- recordings -----------------------------------------------------------------

export async function saveRecording({ userId, sessionId, answerId, storagePath, codec, durationSec, bytes }) {
  if (!pool || !userId) return;
  await q(`insert into recordings (user_id, assessment_id, answer_id, storage_path, codec, duration_sec, bytes)
           values ($1, (select id from assessments where session_id = $2), $3, $4, $5, $6, $7)`,
    [userId, sessionId || null, answerId || null, storagePath, codec, durationSec ?? null, bytes ?? null]);
}

// ---- erasure (DPDP Act) ---------------------------------------------------------

/**
 * Erase a customer: their recordings (files first, via deleteFile), properties, level history and account;
 * transcripts of their answers are blanked. Kept, without the person: scores and levels (anonymised), the
 * event log and consents (proof). An erasures row records that it was done. → { recordings }
 */
export async function eraseUser(userId, deleteFile) {
  if (!pool || !userId) return { recordings: 0 };
  const userRef = createHash('sha256').update(`sakhi-erasure:${userId}`).digest('hex');
  const { rows: [er] } = await q('insert into erasures (user_ref) values ($1) returning id', [userRef]);
  const files = (await q('select storage_path from recordings where user_id = $1', [userId])).rows.map((r) => r.storage_path);
  for (const f of files) await deleteFile(f);
  await tx(async (c) => {
    await c.query(`update assessment_answers set transcript = null where assessment_id in (select id from assessments where user_id = $1)`, [userId]);
    await c.query(`update events set properties = properties - 'phone' - 'name' where user_id = $1`, [userId]);
    await c.query('delete from otp_requests where phone = (select phone from users where id = $1)', [userId]);
    await c.query('delete from users where id = $1', [userId]);
    await c.query('update erasures set completed_at = now(), recordings = $2 where id = $1', [er.id, files.length]);
  });
  return { recordings: files.length };
}
