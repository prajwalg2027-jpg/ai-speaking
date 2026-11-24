// The admin console's API, under /api/admin (the page itself is public/admin/). Sign-in is the same phone login
// as the app; only the admin team gets in, and each request needs a permission of the person's role (team.js:
// people, roles, ADMIN_PHONES as owners). Every settings change is recorded with who made it. In local development without login, the console is open; a production server
// without login keeps it closed.
//
//   GET  /api/admin/config                 (no login) → how the page signs in
//   GET  /api/admin/me                     → who is signed in
//   GET  /api/admin/overview               → dashboard numbers and 14-day series
//   GET  /api/admin/settings               → every section: value, default, whether changed; providers available
//   PUT  /api/admin/settings/:key          { value } → saved and applied at once (validated; audited)
//   POST /api/admin/settings/:key/reset    → back to the default
//   GET  /api/admin/settings/history       → recent changes
//   POST /api/admin/playground             { message, channel, intensity, level, history? } → A and B side by side (nothing saved)
//   GET  /api/admin/evals                  → evaluation runs;  POST { intensity?, only? } starts one in the background
//   GET  /api/admin/evals/:id              → one run, with every item
//   GET  /api/admin/conversations          → recent learning conversations
//   GET  /api/admin/conversations/:id      → the messages, corrections shown and dropped, timings
//   GET  /api/admin/lessons                → lessons with how learners do in them
//   /api/admin/team/**                     → people and roles (team.js)
//   /api/admin/placement-lab/**            → compare AI models on the conversation placement (placementLab.js)
//   /api/admin/voices/**                   → compare voices, Sarvam's and Google's, with costs (voices.js)
import { pool } from '../db/pool.js';
import * as settings from '../settings.js';
import { configured as voiceConfigured, MODELS as VOICE_MODELS } from '../voices/index.js';
import { loginEnabled, firebaseEnabled, otpEnabled, projectId } from '../auth.js';
import { LIMITS } from '../guard.js';
import { whoIs, need, handleTeam, PERMISSIONS } from './team.js';
import { handlePlacementLab } from './placementLab.js';
import { handleVoices } from './voices.js';
import { listModels } from '../llm/models.js';
import { spentToday, PRICES } from '../costs.js';
import { structured as defaultStructured, providers } from '../llm/index.js';
import { readJson, send, fail, route, isUuid } from '../http.js';
import { tutorTurn } from '../learning/tutor.js';
import { loadDataset } from '../learning/eval.js';
import * as evalRuns from '../learning/evalRuns.js';
import * as payments from '../payments.js';
import { z } from 'zod';

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;
const maskPhone = (p) => (p ? `${p.slice(0, 5)}•••••${p.slice(-3)}` : null);

const needDb = () => { if (!pool) throw fail(503, 'this needs the database (DATABASE_URL)'); };

async function overview() {
  needDb();
  const totals = await one(`select
      (select count(*)::int from users) as learners,
      (select count(*)::int from users where created_at > now() - interval '7 days') as "newLearners7d",
      (select count(*)::int from assessments where status = 'finished' and finished_at > now() - interval '7 days') as "tests7d",
      (select count(*)::int from messages where role = 'learner' and created_at > now() - interval '1 day') as "messages24h",
      (select count(distinct c.user_id)::int from messages m join conversations c on c.id = m.conversation_id
         where m.role = 'learner' and m.created_at > now() - interval '7 days') as "activeLearners7d",
      (select count(*)::int from lesson_sessions where status = 'completed' and completed_at > now() - interval '7 days') as "lessonsCompleted7d",
      (select count(*)::int from corrections where created_at > now() - interval '7 days') as "corrections7d",
      (select count(*)::int from messages where role = 'tutor' and reply_to is not null and created_at > now() - interval '7 days') as "replies7d"`);
  const day = `(%s at time zone 'Asia/Kolkata')::date`;
  const series = async (sql) => Object.fromEntries((await q(sql)).map((r) => [r.day.toISOString().slice(0, 10), r.n]));
  const [messages, learnersActive, tests, signups] = await Promise.all([
    series(`select ${day.replace('%s', 'created_at')} as day, count(*)::int as n from messages where role = 'learner' and created_at > now() - interval '14 days' group by 1`),
    series(`select ${day.replace('%s', 'm.created_at')} as day, count(distinct c.user_id)::int as n from messages m join conversations c on c.id = m.conversation_id where m.role = 'learner' and m.created_at > now() - interval '14 days' group by 1`),
    series(`select ${day.replace('%s', 'finished_at')} as day, count(*)::int as n from assessments where status = 'finished' and finished_at > now() - interval '14 days' group by 1`),
    series(`select ${day.replace('%s', 'created_at')} as day, count(*)::int as n from users where created_at > now() - interval '14 days' group by 1`),
  ]);
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + 5.5 * 3600_000 - (13 - i) * 86400_000).toISOString().slice(0, 10));
  const levels = await q(`select level, count(*)::int as n from (select distinct on (user_id) level from assessments
      where status = 'finished' and level is not null and user_id is not null order by user_id, finished_at desc) x group by level order by level`);
  const mistakes = await q(`select concept_key as concept, count(*)::int as n from learning_events where kind = 'mistake' and occurred_at > now() - interval '7 days' and concept_key is not null group by 1 order by 2 desc limit 8`);
  const latency = await one(`select count(*)::int as n,
      percentile_cont(0.5) within group (order by (metadata->>'replyMs')::int) as "replyP50",
      percentile_cont(0.95) within group (order by (metadata->>'replyMs')::int) as "replyP95",
      percentile_cont(0.5) within group (order by (metadata->>'totalMs')::int) as "totalP50",
      percentile_cont(0.95) within group (order by (metadata->>'totalMs')::int) as "totalP95",
      sum((metadata->>'costInr')::numeric)::float as "costInr"
    from messages where role = 'tutor' and metadata ? 'replyMs' and created_at > now() - interval '1 day'`);
  const quality = await one(`select
      count(*) filter (where jsonb_array_length(coalesce(metadata->'dropped', '[]')) > 0)::int as "turnsWithDropped",
      coalesce(sum((select count(*) from jsonb_array_elements(coalesce(metadata->'dropped', '[]')) d where d->>'reason' like 'check:%')), 0)::int as "droppedByCheck",
      count(*) filter (where metadata->>'checkError' is not null)::int as "checkErrors"
    from messages where role = 'tutor' and reply_to is not null and created_at > now() - interval '7 days'`);
  return {
    totals, levels, mistakes, latency, quality, payments: { ...(await payments.summary()), required: payments.required(), priceInr: settings.get('payments').priceInr },
    series: { days, messages: days.map((d) => messages[d] || 0), activeLearners: days.map((d) => learnersActive[d] || 0), tests: days.map((d) => tests[d] || 0), signups: days.map((d) => signups[d] || 0) },
    spend: { todayInr: +spentToday().toFixed(2), budgetInr: LIMITS.dailyBudgetInr, note: 'this server instance since it started today' },
    llm: settings.get('llm'), strategy: settings.get('corrections').strategy,
  };
}

const Playground = z.strictObject({
  message: z.string().trim().min(1).max(1000),
  channel: z.enum(['text', 'voice']).default('text'),
  intensity: z.enum(['gentle', 'balanced', 'strict']).default('balanced'),
  level: z.number().int().min(1).max(4).nullable().default(2),
  history: z.array(z.strictObject({ role: z.enum(['learner', 'tutor']), content: z.string().max(1000) })).max(20).default([]),
});

/** @param {object} deps { structured } (tests) */
export async function handleAdmin(req, res, url, deps = {}) {
  if (!url.pathname.startsWith('/api/admin/')) return false;
  const p = url.pathname, m = req.method;
  if (m === 'GET' && p === '/api/admin/config') {
    // Sign-in by OTP (MSG91) when it's set up; otherwise Firebase's phone sign-in in the browser.
    const key = process.env.FIREBASE_WEB_API_KEY, otp = otpEnabled();
    return send(res, 200, {
      loginRequired: loginEnabled(), login: otp ? 'otp' : firebaseEnabled() ? 'firebase' : null,
      firebase: !otp && firebaseEnabled() && key ? { apiKey: key, authDomain: `${projectId()}.firebaseapp.com`, projectId: projectId() } : null,
    }), true;
  }
  const who = await whoIs(req);
  res.locals = { user: `admin:${maskPhone(who.phone) || who.phone}` };
  const structured = deps.structured || defaultStructured;
  let a;

  if (m === 'GET' && p === '/api/admin/me') return send(res, 200, { ...who, permissionLabels: PERMISSIONS }), true;
  if (await handleTeam(req, res, url, who)) return true;
  if (m === 'GET' && p === '/api/admin/overview') return need(who, 'dashboard.view'), send(res, 200, await overview()), true;

  if (m === 'GET' && p === '/api/admin/settings') {
    need(who, 'settings.view');
    const now = settings.all();
    return send(res, 200, {
      sections: Object.fromEntries(Object.entries(settings.SECTIONS).map(([k, s]) => [k, { label: s.label, value: now[k], defaults: s.defaults, changed: JSON.stringify(now[k]) !== JSON.stringify(s.defaults) }])),
      providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { configured: v.configured(), via: v.via?.() ?? null }])),
      prices: PRICES, models: await listModels(), // for the model menus
    }), true;
  }
  if (m === 'GET' && p === '/api/admin/settings/history') return need(who, 'settings.view'), send(res, 200, { changes: await settings.history(100) }), true;
  if (m === 'PUT' && (a = route('/api/admin/settings/:key', p))) {
    need(who, 'settings.edit');
    const b = await readJson(req);
    if (a.key === 'llm') for (const [job, cfg] of Object.entries(b.value || {})) if (cfg?.provider && !providers[cfg.provider]?.configured()) throw fail(400, `${cfg.provider} is not set up on the server (its API key is missing), so ${job} can't use it`);
    if (a.key === 'voice' && b.value?.source && b.value.source !== 'sarvam') {
      if (!voiceConfigured[b.value.source]?.()) throw fail(400, b.value.source === 'gemini' ? 'The Gemini API has no key on the server (GEMINI_API_KEY), so its voices can\'t be used.' : 'Google Cloud Text-to-Speech works only on the deployed server.');
      if (!VOICE_MODELS[b.value.source]?.[b.value.model]) throw fail(400, `${b.value.model} is not one of the voice models for ${b.value.source}: ${Object.keys(VOICE_MODELS[b.value.source] || {}).join(', ')}`);
    }
    return send(res, 200, { value: await settings.set(a.key, b.value, who.phone) }), true;
  }
  if (m === 'POST' && (a = route('/api/admin/settings/:key/reset', p))) {
    need(who, 'settings.edit');
    if (!settings.SECTIONS[a.key]) throw fail(404, 'unknown section');
    return send(res, 200, { value: await settings.reset(a.key, who.phone) }), true;
  }

  if (p.startsWith('/api/admin/placement-lab')) { need(who, 'playground.use'); return handlePlacementLab(req, res, url, { structured: deps.structured }); }
  if (p === '/api/admin/voices' || p.startsWith('/api/admin/voices/')) { need(who, 'playground.use'); return handleVoices(req, res, url); }
  if (m === 'POST' && p === '/api/admin/playground') {
    need(who, 'playground.use');
    const b = Playground.safeParse(await readJson(req));
    if (!b.success) throw fail(400, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const t = await tutorTurn({ structured, settings: { corrections: settings.get('corrections'), conversation: settings.get('conversation') }, compare: true, strategy: 'single',
      message: b.data.message, channel: b.data.channel, intensity: b.data.intensity, profile: { level: b.data.level }, history: b.data.history });
    return send(res, 200, { reply: t.reply, encouragement: t.encouragement, followUpQuestion: t.followUpQuestion, proposed: t.proposed, signals: t.signals, compare: t.compare, meta: t.meta }), true;
  }

  if (m === 'GET' && p === '/api/admin/evals') {
    need(who, 'evals.view'); needDb();
    const ds = await loadDataset();
    const runs = (await evalRuns.list(30)).map((r) => ({ ...r, progress: evalRuns.progressOf(r.id) }));
    return send(res, 200, { runs, dataset: { version: ds.version, items: ds.items.length, groups: [...new Set(ds.items.map((i) => i.group))] } }), true;
  }
  if (m === 'POST' && p === '/api/admin/evals') {
    need(who, 'evals.run'); needDb();
    const b = await readJson(req);
    const id = await evalRuns.start({ intensity: ['gentle', 'balanced', 'strict'].includes(b.intensity) ? b.intensity : undefined, only: Array.isArray(b.only) ? b.only.map(String) : null, startedBy: who.phone, structured });
    return send(res, 202, { id }), true;
  }
  if (m === 'GET' && (a = route('/api/admin/evals/:id', p))) {
    need(who, 'evals.view'); needDb();
    const r = isUuid(a.id) ? await evalRuns.get(a.id) : null;
    if (!r) throw fail(404, 'run not found');
    return send(res, 200, { ...r, progress: evalRuns.progressOf(r.id) }), true;
  }

  if (m === 'GET' && p === '/api/admin/conversations') {
    need(who, 'conversations.view'); needDb();
    const rows = await q(`select c.id, c.mode, c.title, c.started_at, c.last_message_at, u.phone, u.name,
        (select count(*)::int from messages m where m.conversation_id = c.id and m.role = 'learner') as learner_messages,
        (select count(*)::int from corrections k join messages m on m.id = k.message_id where m.conversation_id = c.id) as corrections,
        (select content from messages m where m.conversation_id = c.id and m.role = 'learner' order by created_at desc limit 1) as last_learner_message
      from conversations c left join users u on u.id = c.user_id order by c.last_message_at desc limit 100`);
    return send(res, 200, { conversations: rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })) }), true;
  }
  if (m === 'GET' && (a = route('/api/admin/conversations/:id', p))) {
    need(who, 'conversations.view'); needDb();
    const c = isUuid(a.id) ? await one(`select c.*, u.phone, u.name from conversations c left join users u on u.id = c.user_id where c.id = $1`, [a.id]) : null;
    if (!c) throw fail(404, 'conversation not found');
    const msgs = await q('select * from messages where conversation_id = $1 order by created_at, id', [c.id]);
    const corr = await q('select * from corrections where message_id = any($1) order by created_at', [msgs.map((x) => x.id)]);
    return send(res, 200, { conversation: { ...c, phone: maskPhone(c.phone) }, messages: msgs.map((x) => ({ ...x, corrections: corr.filter((k) => k.message_id === x.id) })) }), true;
  }
  if (m === 'GET' && p === '/api/admin/lessons') {
    need(who, 'lessons.view'); needDb();
    const rows = await q(`select l.id, l.title, l.category, l.level, l.version, l.active,
        count(s.id)::int as started, count(s.id) filter (where s.status = 'completed')::int as completed,
        round(avg(s.correct_count::numeric / nullif((l.content->>'exerciseCount')::int, 0)) filter (where s.status = 'completed') * 100)::int as "avgScorePct"
      from lessons l left join lesson_sessions s on s.lesson_id = l.id group by l.id order by l.level, l.position`);
    return send(res, 200, { lessons: rows }), true;
  }
  throw fail(404, 'not found');
}
