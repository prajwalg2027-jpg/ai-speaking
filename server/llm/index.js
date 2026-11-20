// The AI provider layer: the tutor's code asks for "a structured answer for this job" and never deals with a
// provider directly. Which provider and model each job uses comes from the admin settings (server/settings.js):
// Sarvam by default; OpenAI if switched on there and OPENAI_API_KEY is set on the server (keys never leave it).
//
// Every answer is parsed and validated against its schema. A malformed answer gets one corrective retry (the
// model is told what was wrong); a busy or failing provider is retried by the provider client itself. These
// calls have no side effects, so retrying them can't duplicate anything: saving happens later, once.
import * as settings from '../settings.js';
import * as sarvam from '../sarvam.js';
import { openaiChat, openaiConfigured } from './openai.js';

export class LlmError extends Error {
  constructor(message, { kind = 'provider', detail = null } = {}) { super(message); this.kind = kind; this.detail = detail; this.status = kind === 'config' ? 503 : 502; this.reason = 'The AI could not answer just now. Please try again.'; }
}

export const providers = {
  sarvam: { configured: () => !!process.env.SARVAM_API_KEY },
  openai: { configured: openaiConfigured },
};

function extractJson(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

async function callProvider(job, messages, { schema, schemaName, maxTokens }) {
  if (job.provider === 'openai') return openaiChat(messages, { model: job.model, temperature: job.temperature, maxTokens, schema, schemaName });
  const meta = {};
  const text = await sarvam.chat(messages, { model: job.model, temperature: job.temperature, maxTokens, json: true, meta, purpose: 'tutor' });
  const u = meta.usage || {};
  return { text, usage: { input: u.prompt_tokens ?? null, output: u.completion_tokens ?? null, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null } };
}

/**
 * Ask for a structured answer.
 * @param {object} p
 * @param {string} p.job        settings key under `llm` (tutor, verify, lessonEval)
 * @param {Array}  p.messages   chat messages
 * @param {import('zod').ZodTypeAny} p.schema
 * @param {string} p.schemaName
 * @param {Function} [p.repair]  maps near-misses onto the schema before validation (see learning/schemas.js)
 * @returns {Promise<{data, provider, model, latencyMs, usage, attempts}>}
 */
export async function structured({ job, messages, schema, schemaName = 'answer', maxTokens = 900, repair = null }) {
  let cfg = settings.get('llm')[job];
  if (!cfg) throw new LlmError(`no settings for job ${job}`, { kind: 'config' });
  if (!providers[cfg.provider]?.configured()) {
    if (cfg.provider === 'sarvam') throw new LlmError('Sarvam is not configured on the server', { kind: 'config' });
    console.warn(`[llm] ${cfg.provider} is selected for ${job} but not configured: using Sarvam`);
    cfg = settings.SECTIONS.llm.defaults[job];
  }
  const t0 = performance.now();
  let convo = messages, last = null, usage = { input: 0, output: 0, reasoning: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try { res = await callProvider(cfg, convo, { schema, schemaName, maxTokens }); }
    catch (e) { throw new LlmError(`${cfg.provider} failed: ${e.message}`, { kind: e.name === 'AbortError' ? 'timeout' : 'provider' }); }
    for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] || 0;
    const json = extractJson(res.text);
    const parsed = json ? schema.safeParse(repair ? repair(json) : json) : null;
    if (parsed?.success) {
      return { data: parsed.data, provider: cfg.provider, model: cfg.model, latencyMs: Math.round(performance.now() - t0), usage, attempts: attempt };
    }
    last = json ? parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ') : 'not valid JSON';
    convo = [...messages, { role: 'assistant', content: String(res.text || '').slice(0, 2000) },
      { role: 'user', content: `That answer was not valid (${last}). Reply again with ONLY the JSON object, exactly in the required shape.` }];
  }
  throw new LlmError(`${cfg.provider} returned an invalid answer twice: ${last}`, { kind: 'invalid', detail: last });
}
