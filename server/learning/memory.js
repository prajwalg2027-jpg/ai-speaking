// Sakhi's memory of each learner, across conversations (docs/LEARNING.md "Learner memory").
//
// What is kept (table learner_memories): short English notes about what the learner told Sakhi — facts about their
// life, goals, coming events (with a date, so she can ask how it went), interests, and how they like to learn —
// plus a short summary of each practice conversation (conversations.summary, topics). Text only; no audio.
//
// How it's written: a background "memory note" (one small AI call, the `memory` job) reads the messages since the
// last note together with what's already known, and returns what to add, update, forget or mark done. It runs every
// few learner messages, when the learner says "forget", and for earlier conversations when a new one starts. It
// never delays Sakhi's reply. Sensitive things (health, religion, money, contact details…) are never kept: the
// prompt says so and `sensitive()` drops anything that slips through.
//
// How it's used: recall() gives the tutor prompt the most useful items, events that are due or coming up, and the
// last conversations' summaries; greeting() opens a new conversation with one of them.
//
// The learner's control: their own switch (learner_profiles.memory_enabled), GET/DELETE /api/learn/memory, and
// "forget …" in a conversation. The admin switch (settings `memory`) turns it all off.
import { z } from 'zod';
import { pool } from '../db/pool.js';
import * as settings from '../settings.js';
import { structured as defaultStructured } from '../llm/index.js';

export const KINDS = ['fact', 'goal', 'event', 'interest', 'preference'];
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0] || null;

/** Today's date in India, YYYY-MM-DD. */
export const todayInIndia = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const weekday = (d = new Date()) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(d);

// ---- what must never be kept ------------------------------------------------------------------------

const SENSITIVE = /\b(health|illness|disease|diabet\w*|cancer|hiv|aids|depress\w*|anxiety|pregnan\w*|surgery|religio\w*|caste|dalit|brahmin|hindu|muslim|christian|sikh|politic\w*|bjp|congress party|voted?|salary|income|loans?|debts?|emi|rupees?|lakhs?|crores?|divorce\w*|boyfriend|girlfriend|affair|sex\w*|passwords?|otp|aadhaar|pan card)\b|₹/i;
/** True for a note that must not be kept: a sensitive subject, or contact details (long numbers, emails, links). */
export const sensitive = (text) => SENSITIVE.test(text) || /\d{6,}|@|https?:\/\/|www\./i.test(String(text).replace(/[\s-]/g, ''));

/** The learner asked Sakhi to forget something (English or Hindi). */
export const asksToForget = (text) => /\bforget\b|\bbh[uo]{1,2}l\s*ja|भूल/i.test(text || '');

// ---- reading -------------------------------------------------------------------------------------------

/** The learner's active memory, most important and most recent first. */
export async function activeMemories(userId, { limit = 200 } = {}) {
  return (await q(`select id::int, kind, content, to_char(due_on, 'YYYY-MM-DD') as due_on, importance, source, created_at, updated_at
      from learner_memories where user_id = $1 and status = 'active' order by importance desc, updated_at desc, id desc limit $2`, [userId, limit])).rows;
}

async function learnerSwitch(userId) {
  const r = await one('select memory_enabled from learner_profiles where user_id = $1', [userId]);
  return r?.memory_enabled !== false;
}

/**
 * What the tutor should remember about the learner on this turn, or null when memory is switched off by the admin
 * (the prompt then works as it did before the memory). A learner who switched theirs off gets { off: true }.
 */
export async function recall(userId, { excludeConversationId = null } = {}) {
  const cfg = settings.get('memory');
  if (!cfg.enabled || !pool) return null;
  const today = todayInIndia();
  if (!(await learnerSwitch(userId))) return { off: true, today, items: [], dueEvents: [], upcoming: [], past: [] };
  const all = await activeMemories(userId, { limit: cfg.maxItems });
  const dated = (m) => m.kind === 'event' && m.due_on;
  const past = cfg.pastConversations ? (await q(`select id, summary, started_at from conversations
      where user_id = $1 and summary is not null and ($2::uuid is null or id <> $2) order by last_message_at desc limit $3`,
  [userId, excludeConversationId, cfg.pastConversations])).rows : [];
  return {
    off: false, today,
    items: all.filter((m) => !dated(m)).slice(0, cfg.inPrompt),
    dueEvents: all.filter((m) => dated(m) && m.due_on <= today).slice(0, 3),
    upcoming: all.filter((m) => dated(m) && m.due_on > today).slice(0, 3),
    past,
  };
}

/** For the app: everything remembered, and the summaries of past conversations. */
export async function view(userId) {
  const [items, convs] = await Promise.all([
    activeMemories(userId),
    q(`select id, summary, topics, started_at from conversations where user_id = $1 and summary is not null order by last_message_at desc limit 20`, [userId]),
  ]);
  return {
    enabled: settings.get('memory').enabled && await learnerSwitch(userId),
    items: items.map((m) => ({ id: m.id, kind: m.kind, content: m.content, dueOn: m.due_on, source: m.source, createdAt: m.created_at, updatedAt: m.updated_at })),
    conversations: convs.rows.map((c) => ({ id: c.id, summary: c.summary, topics: c.topics, startedAt: c.started_at })),
  };
}

// ---- forgetting ----------------------------------------------------------------------------------------

/** Forget one item. → true if it was the learner's. */
export async function forget(userId, id) {
  return (await q('delete from learner_memories where id = $1 and user_id = $2', [id, userId])).rowCount > 0;
}

/** Forget everything: the items, the conversation summaries, and the facts saved by the placement test. */
export async function forgetAll(userId, c = pool) {
  await c.query('delete from learner_memories where user_id = $1', [userId]);
  await c.query(`update conversations set summary = null, topics = '[]' where user_id = $1`, [userId]);
  await c.query(`update users set attributes = attributes - 'conversation_facts', updated_at = now() where id = $1`, [userId]);
  await c.query(`delete from attribute_history where user_id = $1 and key = 'conversation_facts'`, [userId]);
}

/** Retention: summaries older than the admin's limit are removed (run at start and once a day). */
export async function expireSummaries() {
  if (!pool) return 0;
  const days = settings.get('memory').keepSummariesDays;
  return (await q(`update conversations set summary = null, topics = '[]' where summary is not null and last_message_at < now() - make_interval(days => $1)`, [days])).rowCount;
}

// ---- the memory note -----------------------------------------------------------------------------------

const note = z.string().trim().min(3).max(200);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const id = z.number().int();
export const MemoryNote = z.strictObject({
  name: z.string().trim().max(60).nullable(),
  add: z.array(z.strictObject({ kind: z.enum(KINDS), content: note, due_on: day, importance: z.number().int().min(1).max(3) })).max(8),
  update: z.array(z.strictObject({ id, content: note, due_on: day })).max(8),
  forget: z.array(id).max(20),
  done: z.array(id).max(10),
  forget_all: z.boolean(),
  summary: z.string().trim().max(400).nullable(),
  topics: z.array(z.string().trim().min(1).max(40)).max(5),
});

/** Near-misses: missing lists, ids as strings, a bad date. */
export function repairMemoryNote(j) {
  if (!j || typeof j !== 'object') return j;
  const ids = (a) => (Array.isArray(a) ? a.map((x) => (typeof x === 'object' && x ? x.id : x)).map(Number).filter(Number.isInteger) : []);
  const date = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  return {
    name: typeof j.name === 'string' && j.name.trim() ? j.name : null,
    add: (Array.isArray(j.add) ? j.add : []).filter((a) => a && typeof a.content === 'string').map((a) => ({
      kind: KINDS.includes(a.kind) ? a.kind : 'fact', content: a.content, due_on: date(a.due_on),
      importance: [1, 2, 3].includes(Number(a.importance)) ? Number(a.importance) : 2,
    })),
    update: (Array.isArray(j.update) ? j.update : []).filter((u) => u && typeof u.content === 'string' && Number.isInteger(Number(u.id)))
      .map((u) => ({ id: Number(u.id), content: u.content, due_on: date(u.due_on) })),
    forget: ids(j.forget), done: ids(j.done),
    forget_all: j.forget_all === true,
    summary: typeof j.summary === 'string' && j.summary.trim() ? j.summary : null,
    topics: Array.isArray(j.topics) ? j.topics.filter((t) => typeof t === 'string' && t.trim()).slice(0, 5) : [],
  };
}

export function buildNoteMessages({ known, summary, messages, now = new Date() }) {
  return [
    {
      role: 'system',
      content: `You keep short notes for Sakhi, a friendly English tutor, about one adult learner in India, so that she remembers
them in later conversations. Today is ${weekday(now)}, ${todayInIndia(now)}.

Rules:
- Only what the LEARNER said about themselves and their life. Never what Sakhi said, never guesses, never their English mistakes.
- Each note is one short English sentence about the learner, without their name, at most 20 words
  ("Works in a call centre in Pune", "Wants to speak confidently with customers"). Translate Hindi into English.
- kind: "fact" (job, studies, city, family, daily life), "goal" (why they learn English, what they want to be able
  to do), "event" (something ahead with a date: give due_on as YYYY-MM-DD worked out from today; "Friday" is the next
  Friday; no date known → null), "interest" (likes, hobbies, favourite things), "preference" (how they want to learn:
  more Hindi, slower, more corrections, topics they don't want to talk about).
- importance: 3 = central (their work, their main goal, a big coming event), 2 = useful, 1 = a small detail.
- NEVER note: health, religion, caste, politics, money (salary, loans, prices), love life or marriage problems,
  phone numbers, addresses, ids or passwords, or details about other people beyond a mention ("has a sister").
- Don't add what is already known. If something known has changed or is now more precise, put it in "update" with
  its id. If the learner says something known is wrong or no longer true, update it or put its id in "forget".
- If the learner asks Sakhi to forget something, put its id in "forget". Only if they ask her to forget EVERYTHING
  about them: "forget_all": true.
- "done": ids of known events that are over and were talked about, or whose date passed more than a week ago.
- "name": the name the learner wants to be called, only if they say it in these messages; otherwise null.
- "summary": one or two sentences on the whole conversation so far (build on the earlier summary): what they talked
  about and practised. "topics": up to 5 one- or two-word topics.
- Most messages hold nothing new: then "add", "update", "forget" and "done" are empty lists.

Reply with ONLY JSON:
{"name": null, "add": [{"kind": "fact", "content": "...", "due_on": null, "importance": 2}], "update": [{"id": 12, "content": "...", "due_on": null}],
 "forget": [], "done": [], "forget_all": false, "summary": "...", "topics": ["work"]}`,
    },
    {
      role: 'user',
      content: [
        `Already known about the learner (id. kind: note):\n${known.length ? known.map((m) => `${m.id}. ${m.kind}: ${m.content}${m.due_on ? ` (date ${m.due_on})` : ''}`).join('\n') : '(nothing yet)'}`,
        summary ? `Earlier summary of this conversation: ${summary}` : '',
        `New messages:\n${messages.map((m) => `${m.role === 'tutor' ? 'Sakhi' : 'Learner'}: ${m.content}`).join('\n')}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

const running = new Map(); // conversation id → the note being written (one at a time per conversation)
const background = new Set(); // other memory work started in the background

/** Run memory work in the background: errors are logged, never thrown. */
export function inBackground(fn) {
  const p = Promise.resolve().then(fn).catch((e) => console.warn(`[memory] ${e.kind || 'error'}: ${e.message}`));
  background.add(p);
  p.finally(() => background.delete(p));
  return p;
}

/** Wait for every memory note and background job in progress (tests, shutdown). */
export async function settled() {
  while (running.size || background.size) await Promise.allSettled([...running.values(), ...background]);
}

/**
 * Write a memory note for a conversation: read the messages since the last note and update the learner's memory.
 * Safe to call often: one note at a time per conversation, and nothing happens when there's nothing new.
 * → { added, updated, forgotten, done, forgotAll } or { skipped: reason }. Errors are thrown (callers in the
 * background log them); the messages are then read again by the next note.
 */
export function noteConversation({ userId, conversationId, structured = defaultStructured }) {
  if (running.has(conversationId)) return running.get(conversationId);
  const p = writeNote({ userId, conversationId, structured }).finally(() => running.delete(conversationId));
  running.set(conversationId, p);
  return p;
}

async function writeNote({ userId, conversationId, structured }) {
  const cfg = settings.get('memory');
  if (!cfg.enabled || !pool) return { skipped: 'memory is off' };
  const conv = await one('select * from conversations where id = $1', [conversationId]);
  if (!conv || conv.user_id !== userId) return { skipped: 'not found' };
  if (!(await learnerSwitch(userId))) return { skipped: 'the learner switched memory off' };
  const msgs = (await q(`select id, role, content, created_at from messages where conversation_id = $1
      and ($2::timestamptz is null or created_at > $2) order by created_at, id limit 60`, [conv.id, conv.memory_through])).rows;
  if (!msgs.some((m) => m.role === 'learner')) return { skipped: 'nothing new' };

  const known = await activeMemories(userId, { limit: cfg.maxItems });
  const r = await structured({ job: 'memory', messages: buildNoteMessages({ known, summary: conv.summary, messages: msgs }),
    schema: MemoryNote, schemaName: 'memory_note', repair: repairMemoryNote, maxTokens: 800, timeoutMs: 45_000 });
  const n = r.data;
  const learnerText = msgs.filter((m) => m.role === 'learner').map((m) => m.content).join('\n');
  const knownIds = new Set(known.map((m) => m.id));
  const seen = new Set(known.map((m) => m.content.toLowerCase()));
  const out = { added: 0, updated: 0, forgotten: 0, done: 0, forgotAll: false };
  const through = msgs.at(-1).created_at;

  const c = await pool.connect();
  try {
    await c.query('begin');
    // "Forget everything" only when the learner really said "forget" (a misread note must not wipe the memory).
    if (n.forget_all && asksToForget(learnerText)) {
      await forgetAll(userId, c);
      out.forgotAll = true;
    } else {
      for (const fid of new Set(n.forget)) if (knownIds.has(fid)) out.forgotten += (await c.query('delete from learner_memories where id = $1 and user_id = $2', [fid, userId])).rowCount;
      for (const did of new Set(n.done)) if (knownIds.has(did) && !n.forget.includes(did)) out.done += (await c.query(`update learner_memories set status = 'done', updated_at = now() where id = $1 and user_id = $2 and status = 'active'`, [did, userId])).rowCount;
      for (const u of n.update) {
        if (!knownIds.has(u.id) || n.forget.includes(u.id) || sensitive(u.content)) continue;
        out.updated += (await c.query(`update learner_memories set content = $3, due_on = coalesce($4::date, due_on), conversation_id = $5, updated_at = now()
            where id = $1 and user_id = $2 and status = 'active'`, [u.id, userId, u.content, u.due_on, conv.id])).rowCount;
      }
      for (const a of n.add) {
        const key = a.content.toLowerCase();
        if (sensitive(a.content) || seen.has(key)) continue;
        seen.add(key);
        await c.query(`insert into learner_memories (user_id, kind, content, due_on, importance, source, conversation_id) values ($1, $2, $3, $4, $5, 'conversation', $6)`,
          [userId, a.kind, a.content, a.kind === 'event' ? a.due_on : null, a.importance, conv.id]);
        out.added++;
      }
      // Past the limit, the least important old items fade.
      await c.query(`update learner_memories set status = 'faded', updated_at = now() where id in (
          select id from learner_memories where user_id = $1 and status = 'active' order by importance desc, updated_at desc, id desc offset $2)`, [userId, cfg.maxItems]);
    }
    const summary = out.forgotAll || !n.summary || sensitive(n.summary) ? (out.forgotAll ? null : conv.summary) : n.summary;
    await c.query(`update conversations set summary = $2, topics = case when $3::boolean then '[]'::jsonb when jsonb_array_length($4::jsonb) > 0 then $4::jsonb else topics end,
        memory_through = $5 where id = $1`, [conv.id, summary, out.forgotAll, JSON.stringify(n.topics.filter((t) => !sensitive(t))), through]);
    if (n.name && !out.forgotAll && !sensitive(n.name) && /^[\p{L} .'-]{1,40}$/u.test(n.name.trim())) {
      await c.query(`update users set name = $2, attributes = jsonb_set(attributes, '{name}', to_jsonb($2::text)), updated_at = now() where id = $1 and name is distinct from $2`, [userId, n.name.trim()]);
    }
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  return out;
}

/** Earlier conversations with messages no note has read yet (most recent first). */
export async function unnoted(userId, { exceptId = null, limit = 2 } = {}) {
  return (await q(`select c.id from conversations c where c.user_id = $1 and ($2::uuid is null or c.id <> $2)
      and exists (select 1 from messages m where m.conversation_id = c.id and m.role = 'learner' and (c.memory_through is null or m.created_at > c.memory_through))
      order by c.last_message_at desc limit $3`, [userId, exceptId, limit])).rows.map((r) => r.id);
}

/** How many learner messages a conversation has that no note has read yet. */
export async function unreadCount(conversationId) {
  return (await one(`select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id
      where c.id = $1 and m.role = 'learner' and (c.memory_through is null or m.created_at > c.memory_through)`, [conversationId])).n;
}

// ---- the personal greeting -----------------------------------------------------------------------------

export const Greeting = z.strictObject({ greeting: z.string().trim().min(5).max(300), asked_about: z.array(id).max(3) });

export function buildGreetingMessages({ name, level, memory }) {
  const lines = [
    name ? `Learner's name: ${name}.` : 'Name not known (do not invent one).',
    `Level: ${level ? `${level} of 4` : 'not known (assume basic)'}.`,
    memory.dueEvents.length ? `Events that have now happened (id. note): ${memory.dueEvents.map((e) => `${e.id}. ${e.content} (${e.due_on})`).join('; ')}` : '',
    memory.upcoming.length ? `Coming up: ${memory.upcoming.map((e) => `${e.content} (${e.due_on})`).join('; ')}` : '',
    memory.items.length ? `What you remember: ${memory.items.slice(0, 8).map((m) => m.content).join('; ')}` : '',
    memory.past.length ? `Your last conversation: ${memory.past[0].summary}` : '',
  ].filter(Boolean);
  return [
    {
      role: 'system',
      content: `You are Sakhi, a warm English tutor for adult learners in India. Write the first line of a new practice
conversation with a learner you already know. Today is ${weekday()}, ${todayInIndia()}.
Greet them (by name if known) and pick ONE thing you remember to start the talk: best, ask how an event that has now
happened went; otherwise follow up on the last conversation, or something about their goal or life. Then one easy
question. At most two short sentences, simple English for their level, no lists, no emojis. Never mention anything
you were not told, and never say "I remember" about more than one thing.
"asked_about": the ids of the events you asked about (or []).
Reply with ONLY JSON: {"greeting": "...", "asked_about": []}`,
    },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * A personal first line for a new conversation, or null (no memory to use, memory off, or the AI failed: the
 * caller then uses the plain greeting). Events it asks about are marked done, so Sakhi asks only once.
 */
export async function greeting({ userId, profile, structured = defaultStructured, timeoutMs = 6000 }) {
  const cfg = settings.get('memory');
  if (!cfg.enabled || !cfg.personalGreeting || !pool) return null;
  const memory = await recall(userId);
  if (!memory || memory.off || (!memory.items.length && !memory.dueEvents.length && !memory.past.length)) return null;
  try {
    const r = await structured({ job: 'memory', messages: buildGreetingMessages({ name: profile?.name, level: profile?.level, memory }),
      schema: Greeting, schemaName: 'greeting', maxTokens: 300, timeoutMs });
    const ids = r.data.asked_about.filter((i) => memory.dueEvents.some((e) => e.id === i));
    if (ids.length) await q(`update learner_memories set status = 'done', updated_at = now() where user_id = $1 and id = any($2)`, [userId, ids]);
    return { text: r.data.greeting, askedAbout: ids, provider: r.provider, model: r.model };
  } catch (e) {
    console.warn(`[memory] personal greeting failed (${e.kind || 'error'}): ${e.message}`);
    return null;
  }
}
