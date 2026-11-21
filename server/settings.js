// Settings the admin console can change without a deploy: which AI provider and model each job uses, the
// correction approach, limits, the placement test's cut-offs, and feature switches. Stored in app_settings
// (one row per section), every change in settings_audit. Each section has a schema; a change that doesn't fit
// is refused. Without a database (local development) the defaults apply and changes stay in memory.
import { z } from 'zod';
import { pool } from './db/pool.js';
import { CONFIG as SCORING_DEFAULTS, setScoringConfig } from './scoring.js';

const num = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== '' ? Number(process.env[k]) : d);
const llmJob = z.strictObject({
  provider: z.enum(['sarvam', 'openai']),
  model: z.string().min(1).max(100),
  temperature: z.number().min(0).max(1.5),
});

/** Each section: its schema and its default. */
export const SECTIONS = {
  llm: {
    label: 'AI models',
    schema: z.strictObject({ tutor: llmJob, verify: llmJob, lessonEval: llmJob }),
    defaults: {
      tutor: { provider: 'sarvam', model: 'sarvam-105b-conversations', temperature: 0.6 },
      verify: { provider: 'sarvam', model: 'sarvam-105b', temperature: 0 },
      lessonEval: { provider: 'sarvam', model: 'sarvam-105b', temperature: 0 },
    },
  },
  corrections: {
    label: 'Corrections',
    schema: z.strictObject({
      strategy: z.enum(['single', 'verify']),          // A: one call; B: one call + a check when corrections are proposed
      defaultIntensity: z.enum(['gentle', 'balanced', 'strict']),
      voiceSafe: z.boolean(),                           // drop corrections a speech-to-text slip could explain
      maxPerReply: z.strictObject({ gentle: z.number().int().min(0).max(5), balanced: z.number().int().min(0).max(8), strict: z.number().int().min(0).max(10) }),
    }),
    defaults: { strategy: 'verify', defaultIntensity: 'balanced', voiceSafe: true, maxPerReply: { gentle: 1, balanced: 3, strict: 5 } },
  },
  conversation: {
    label: 'Conversation',
    schema: z.strictObject({ historyMessages: z.number().int().min(2).max(30) }),
    defaults: { historyMessages: 10 },
  },
  limits: {
    label: 'Limits and budget',
    schema: z.strictObject({
      dailyBudgetInr: z.number().min(0).max(1_000_000),
      sessionsPerIpPerHour: z.number().int().min(1).max(10_000),
      turnsPerSession: z.number().int().min(5).max(1000),
      listenSecPerSession: z.number().int().min(60).max(36_000),
      learnMessagesPerDay: z.number().int().min(10).max(100_000),
    }),
    defaults: {
      dailyBudgetInr: num('SAKHI_DAILY_BUDGET_INR', 3000),
      sessionsPerIpPerHour: num('SAKHI_SESSIONS_PER_IP_HOUR', 30),
      turnsPerSession: num('SAKHI_TURNS_PER_SESSION', 80),
      listenSecPerSession: num('SAKHI_LISTEN_SEC_PER_SESSION', 20 * 60),
      learnMessagesPerDay: num('SAKHI_LEARN_MESSAGES_PER_DAY', 400),
    },
  },
  payments: {
    label: 'Payments',
    schema: z.strictObject({
      enabled: z.boolean(),                              // the learning module needs a subscription
      priceInr: z.number().int().min(1).max(100_000),    // a month; a new price makes a new Razorpay plan
    }),
    defaults: { enabled: false, priceInr: 299 },
  },
  features: {
    label: 'Features',
    schema: z.strictObject({ learningModule: z.boolean() }),
    defaults: { learningModule: true },
  },
  scoring: {
    label: 'Placement test cut-offs',
    schema: z.object({
      levelCutoffs: z.strictObject({ level4: z.number(), level3: z.number(), level2: z.number() }),
      difficultyBonus: z.number().min(0).max(2),
      level4Talk: z.number().min(0).max(4),
      readAccuracyCap: z.number().min(0).max(1),
      hindiHelpCap: z.number().int().min(1).max(10),
      firstGuess: z.strictObject({ level4Score: z.number(), level4Words: z.number().int().min(0), level3Score: z.number() }),
      judgeWeight: z.strictObject(Object.fromEntries(['comprehension', 'vocabulary', 'grammar', 'fluency', 'pronunciation', 'coherence'].map((k) => [k, z.number().min(0).max(1)]))),
    }).passthrough().refine((c) => c.levelCutoffs.level4 > c.levelCutoffs.level3 && c.levelCutoffs.level3 > c.levelCutoffs.level2, 'The level cut-offs must go up: level 2 < level 3 < level 4'),
    defaults: SCORING_DEFAULTS,
  },
};

const current = Object.fromEntries(Object.entries(SECTIONS).map(([k, s]) => [k, structuredClone(s.defaults)]));
let loadedAt = 0;

function apply(key, value) {
  current[key] = value;
  if (key === 'scoring') setScoringConfig(value);
}

/** Read every section from the database (defaults for those never changed). Called at start and every 30 s. */
export async function load() {
  if (!pool) return current;
  const { rows } = await pool.query('select key, value from app_settings');
  for (const { key, value } of rows) {
    const s = SECTIONS[key];
    if (!s) continue;
    const parsed = s.schema.safeParse(value);
    if (parsed.success) apply(key, parsed.data);
    else console.warn(`[settings] stored ${key} is invalid, keeping the default:`, parsed.error.issues[0]?.message);
  }
  loadedAt = Date.now();
  return current;
}

/** A section's current value. Refreshed in the background so admin changes reach every request quickly. */
export function get(key) {
  if (pool && Date.now() - loadedAt > 30_000) { loadedAt = Date.now(); load().catch((e) => console.warn('[settings] refresh failed:', e.message)); }
  return current[key];
}

export const all = () => structuredClone(current);

/** Change a section (validated, saved, audited, applied at once). → the new value, or throws 400 with the reason. */
export async function set(key, value, by) {
  const s = SECTIONS[key];
  if (!s) throw Object.assign(new Error(`unknown settings section: ${key}`), { status: 404 });
  const parsed = s.schema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(`${s.label}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`), { status: 400 });
  const old = current[key];
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`insert into app_settings (key, value, updated_by) values ($1, $2, $3)
                     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [key, JSON.stringify(parsed.data), by || null]);
      await c.query('insert into settings_audit (key, old_value, new_value, changed_by) values ($1, $2, $3, $4)', [key, JSON.stringify(old), JSON.stringify(parsed.data), by || null]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }
  apply(key, parsed.data);
  return parsed.data;
}

/** Put a section back to its default. */
export const reset = (key, by) => set(key, structuredClone(SECTIONS[key].defaults), by);

export async function history(limit = 50) {
  if (!pool) return [];
  return (await pool.query('select key, old_value, new_value, changed_by, changed_at from settings_audit order by id desc limit $1', [limit])).rows;
}
