// The AI provider layer: the tutor's code asks for "a structured answer for this job" and never deals with a
// provider directly. Which provider and model each job uses comes from the admin settings (server/settings.js):
// Sarvam by default; OpenAI, Claude (Anthropic) or Gemini if switched on there and that provider's key is set on
// the server (keys never leave it). A caller can also pass its own `config` (the placement test, model comparisons).
//
// Every answer is parsed and validated against its schema. A malformed answer gets one corrective retry (the
// model is told what was wrong); a busy or failing provider is retried by the provider client itself. These
// calls have no side effects, so retrying them can't duplicate anything: saving happens later, once.
import * as settings from '../settings.js';
import * as sarvam from '../sarvam.js';
import { openaiChat, openaiConfigured, geminiChat, geminiConfigured } from './openai.js';
import { anthropicChat, anthropicConfigured } from './anthropic.js';
import { costInr } from './prices.js';

export class LlmError extends Error {
  constructor(message, { kind = 'provider', detail = null } = {}) { super(message); this.kind = kind; this.detail = detail; this.status = kind === 'config' ? 503 : 502; this.reason = 'The AI could not answer just now. Please try again.'; }
}

export const providers = {
  sarvam: { configured: () => !!process.env.SARVAM_API_KEY },
  openai: { configured: openaiConfigured },
  anthropic: { configured: anthropicConfigured },
  gemini: { configured: geminiConfigured },
};

function extractJson(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/**
 * A system message after the first one (a note for one turn, see placement/brain.js) is kept as it is for
 * OpenAI's Responses API. The others take system instructions only at the start, so there it becomes a user
 * message marked as coming from the app.
 */
export const lateSystemAsUser = (messages) => messages.map((m, i) => (i > 0 && m.role === 'system'
  ? { role: 'user', content: fromTheApp(m.content) } : m));
/** A system message in mid-talk, for a provider that takes none there: marked as the app's, unless it already says so. */
export const fromTheApp = (text) => (text.startsWith('[System]') ? text : `[Note from the app, not said by the learner]\n${text}`);

/** The providers whose answer can be streamed (onText). */
export const streams = (provider) => provider === 'openai';
/** The providers that can be told how hard to think. The others ignore it. */
export const takesEffort = (provider) => provider === 'openai' || provider === 'anthropic';

async function callProvider(job, messages, { schema, schemaName, maxTokens, wantThinking = false, effort = null, onText = null, fast = false }) {
  if (job.provider === 'openai') return openaiChat(messages, { model: job.model, temperature: job.temperature, maxTokens, schema, schemaName, wantThinking, effort, onText, fast });
  if (job.provider === 'gemini') return geminiChat(lateSystemAsUser(messages), { model: job.model, temperature: job.temperature, maxTokens, schema, schemaName });
  // Current Claude models reject temperature, so it isn't passed.
  if (job.provider === 'anthropic') return anthropicChat(messages, { model: job.model, maxTokens, schema, schemaName, wantThinking, effort });
  const meta = {};
  const text = await sarvam.chat(lateSystemAsUser(messages), { model: job.model, temperature: job.temperature, maxTokens, json: true, meta, purpose: 'tutor' });
  const u = meta.usage || {};
  return { text, thinking: meta.thinking || null, usage: { input: u.prompt_tokens ?? null, cached: u.prompt_tokens_details?.cached_tokens ?? null, output: u.completion_tokens ?? null, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null } };
}

/**
 * Ask for a structured answer.
 * @param {object} p
 * @param {string} p.job        settings key under `llm` (tutor, verify, lessonEval); with `config`, only a label
 * @param {{provider, model, temperature}} [p.config]  use this instead of the job's settings
 * @param {Array}  p.messages   chat messages
 * @param {import('zod').ZodTypeAny} p.schema
 * @param {string} p.schemaName
 * @param {Function} [p.repair]  maps near-misses onto the schema before validation (see learning/schemas.js)
 * @param {number} [p.timeoutMs]  give up (LlmError kind 'timeout') if the whole call, retries included, takes longer
 * @param {boolean} [p.wantThinking]  ask the provider for a summary of the model's thinking (the admin's log)
 * @param {(text: string) => void} [p.onText]  stream the answer (OpenAI only): called with its text so far as it is written.
 *                                             The first answer only; not called again if the model is asked to repair it.
 * @param {boolean} [p.schemaToProvider]  false: ask for plain JSON and check it here only (the format is then in the
 *                                         instructions). For answers that leave fields out, which a provider's strict schema can't.
 * @param {boolean} [p.fast]  OpenAI's Fast mode (quicker, dearer), for the models that have it
 * @param {string} [p.effort]  how hard to think: 'none'|'low'|'medium'|'high' (OpenAI and Claude; 'default' or nothing: the model's own)
 * @returns {Promise<{data, provider, model, latencyMs, usage, costInr, attempts, raw, thinking, firstTextMs}>}  costInr: an estimate, or null
 */
export async function structured({ job, config = null, timeoutMs = null, messages, schema, schemaName = 'answer', maxTokens = 900, repair = null, wantThinking = false, effort = null, onText = null, schemaToProvider = true, fast = false }) {
  effort = effort && effort !== 'default' ? effort : null;
  let cfg = config || settings.get('llm')[job];
  if (!cfg) throw new LlmError(`no settings for job ${job}`, { kind: 'config' });
  if (!providers[cfg.provider]?.configured()) {
    if (cfg.provider === 'sarvam') throw new LlmError('Sarvam is not configured on the server', { kind: 'config' });
    console.warn(`[llm] ${cfg.provider} is selected for ${job} but not configured: using Sarvam`);
    cfg = settings.SECTIONS.llm.defaults[job] || { provider: 'sarvam', model: 'sarvam-105b', temperature: cfg.temperature ?? 0.3 };
  }
  if (!timeoutMs) return ask(cfg, { messages, schema, schemaName, maxTokens, repair, wantThinking, effort, onText, schemaToProvider, fast });
  // The provider call can't be cancelled from here, so it may finish in the background; its result is ignored.
  let timer;
  const run = ask(cfg, { messages, schema, schemaName, maxTokens, repair, wantThinking, effort, onText, schemaToProvider, fast });
  run.catch(() => {});
  return Promise.race([run, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LlmError(`${cfg.provider} took longer than ${timeoutMs} ms`, { kind: 'timeout' })), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

async function ask(cfg, { messages, schema, schemaName, maxTokens, repair, wantThinking, effort, onText, schemaToProvider, fast }) {
  const t0 = performance.now();
  let convo = messages, last = null, usage = { input: 0, cached: 0, output: 0, reasoning: 0 }; // input includes the cached part; output includes reasoning
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try { res = await callProvider(cfg, convo, { schema: schemaToProvider ? schema : null, schemaName, maxTokens, wantThinking, effort, onText: attempt === 1 ? onText : null, fast }); }
    catch (e) { throw new LlmError(`${cfg.provider} failed: ${e.message}`, { kind: e.name === 'AbortError' ? 'timeout' : 'provider' }); }
    for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] || 0;
    const json = extractJson(res.text);
    const parsed = json ? schema.safeParse(repair ? repair(json) : json) : null;
    if (parsed?.success) {
      return { data: parsed.data, provider: cfg.provider, model: cfg.model, latencyMs: Math.round(performance.now() - t0), usage, costInr: costInr({ provider: cfg.provider, model: cfg.model, usage, price: cfg.price, tier: res.tier }), attempts: attempt, tier: res.tier ?? null,
        raw: String(res.text ?? ''), thinking: res.thinking || null, firstTextMs: res.firstTextMs ?? null }; // raw: the model's answer exactly as it came; thinking: its summary, when shared
    }
    last = json ? parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ') : 'not valid JSON';
    convo = [...messages, { role: 'assistant', content: String(res.text || '').slice(0, 2000) },
      { role: 'user', content: `That answer was not valid (${last}). Reply again with ONLY the JSON object, exactly in the required shape.` }];
  }
  throw new LlmError(`${cfg.provider} returned an invalid answer twice: ${last}`, { kind: 'invalid', detail: last });
}
