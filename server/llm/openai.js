// OpenAI and Gemini as optional providers (off unless switched on in the admin settings AND the provider's key is
// set on the server). OpenAI is called through its Responses API (POST /responses: the conversation goes in
// `input`, the JSON shape in `text.format`). Gemini is called through Google's OpenAI-compatible chat-completions
// endpoint: Vertex AI's (the default, see below) or, with GOOGLE_GENAI_USE_VERTEXAI=false, Google AI Studio's (a key).
// Both use native structured outputs (a strict JSON schema generated from the Zod schema).
// Requests are stateless: the whole talk is sent each time and nothing is stored at the provider (`store: false`).
// The talk only grows from turn to turn, so the provider reuses the repeated part (prompt caching) by itself.
// Not exercised against the live APIs in this repository's tests (no keys): see docs/LEARNING.md.
import { z } from 'zod';

// Base URL and key are read at call time, so tests (and a changed env) take effect without a re-import.
const PROVIDERS = {
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL', defaultBase: 'https://api.openai.com/v1', maxParam: 'max_completion_tokens' },
  gemini: {
    label: 'Gemini', maxParam: 'max_tokens',
    /** Where to send a chat, with what sign-in, and the model's name there. */
    async endpoint(model) {
      if (vertexOn()) return { base: await vertexBase(), token: await vertexToken(), model: model.includes('/') ? model : `google/${model}` };
      return { base: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai', token: process.env.GEMINI_API_KEY, model };
    },
  },
};

// Gemini through Vertex AI (Google Cloud) instead of the Gemini API (Google AI Studio): the same models, billed to
// the Google Cloud project, so Google Cloud credits (the $300 free trial) pay for them; they can't pay for AI Studio.
// The default: off only with GOOGLE_GENAI_USE_VERTEXAI=false (the Google Gen AI SDK's own switch), which goes back to
// the Gemini API and its key (GEMINI_API_KEY). No API key: the server signs in as its
// Google Cloud account (on Cloud Run its service account, which needs roles/aiplatform.user; on a laptop,
// `gcloud auth application-default login`). Set up with deploy/vertex-setup.sh. Vertex AI's OpenAI-compatible
// endpoint takes the same request; models are named google/<model>.
//   GOOGLE_CLOUD_PROJECT   the project (found from the sign-in if not set)
//   GOOGLE_CLOUD_LOCATION  "global" (the default: every model, the newest first) or a region like asia-south1
//   VERTEX_BASE_URL        the whole endpoint, instead of the two above (tests)
export const vertexOn = () => !/^(0|false|no|off)$/i.test((process.env.GOOGLE_GENAI_USE_VERTEXAI || '').trim());
let googleAuth = null;
let tokenSource = null;
/** Tests: hand out this token instead of signing in to Google Cloud (null: sign in again). */
export const setVertexTokenSource = (fn) => { tokenSource = fn; };
async function vertexAuth() {
  if (!googleAuth) {
    const { GoogleAuth } = await import('google-auth-library');
    googleAuth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  }
  return googleAuth;
}
/** A short-lived access token for the server's Google Cloud account (kept and renewed by the library). */
export async function vertexToken() {
  if (tokenSource) return tokenSource();
  try { return await (await vertexAuth()).getAccessToken(); }
  catch (e) { throw new Error(`Gemini (Vertex AI): couldn't sign in to Google Cloud (${String(e.message).slice(0, 200)}). On a laptop: gcloud auth application-default login`); }
}
/** Vertex AI's OpenAI-compatible endpoint for this project and location. */
export async function vertexBase() {
  if (process.env.VERTEX_BASE_URL) return process.env.VERTEX_BASE_URL;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
  const project = process.env.GOOGLE_CLOUD_PROJECT || await (await vertexAuth()).getProjectId();
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

// Models that refused a temperature (newer OpenAI models accept only their default): not sent to them again.
const noTemperature = new Set();
// Models that refused a request for a summary of their thinking (they don't think, or the account can't see it).
const noThinking = new Set();

/**
 * How hard a Gemini model thinks, in the OpenAI-compatible words Google takes (aistudio.google.com/docs/openai):
 * thinking can be turned off only on the 2.5 models ("none"); for the others "none" is their least ("minimal").
 * "xhigh" exists only on gemini-4-neon and gemini-4-hydrogen; elsewhere the most is "high".
 */
export function geminiEffort(model, effort) {
  if (!effort) return null;
  if (effort === 'none') return /^gemini-2\.5/.test(model) && !/pro/.test(model) ? 'none' : 'minimal';
  if (effort === 'xhigh' || effort === 'max') return /^gemini-4-(neon|hydrogen)/.test(model) ? 'xhigh' : 'high';
  return effort;
}

async function chatCompletions(p, messages, { model, temperature, maxTokens, schema, schemaName, effort = null }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const to = await p.endpoint(model);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${to.base}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { authorization: `Bearer ${to.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: to.model, messages, ...(noTemperature.has(`${p.label}/${model}`) ? {} : { temperature }), [p.maxParam]: maxTokens,
          ...(effort && !noEffort.has(`${p.label}/${model}`) ? { reasoning_effort: effort } : {}),
          response_format: schema
            ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: z.toJSONSchema(schema, { target: 'draft-7' }) } }
            : { type: 'json_object' },
        }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        // "temperature does not support 0.6 with this model": ask again without it, and remember.
        if (res.status === 400 && /temperature/i.test(body) && !noTemperature.has(`${p.label}/${model}`)) { noTemperature.add(`${p.label}/${model}`); continue; }
        if (res.status === 400 && effort && /reasoning|thinking|effort/i.test(body) && !noEffort.has(`${p.label}/${model}`)) { noEffort.add(`${p.label}/${model}`); continue; }
        const hint = vertexOn() && (res.status === 401 || res.status === 403) ? ' (Vertex AI: is aiplatform.googleapis.com on, and does the server\'s account have roles/aiplatform.user? deploy/vertex-setup.sh does both)' : '';
        throw new Error(`${p.label} ${res.status}: ${body.slice(0, 300)}${hint}`);
      }
      const j = await res.json();
      const u = j.usage || {};
      return { text: j.choices?.[0]?.message?.content ?? '', usage: { input: u.prompt_tokens ?? null, cached: u.prompt_tokens_details?.cached_tokens ?? null, output: u.completion_tokens ?? null, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null } };
    }
  } finally { clearTimeout(timer); }
}

const noEffort = new Set(); // models that refused a thinking level
const noStream = new Set(); // models that refused to stream
const noFast = new Set(); // models that have no Fast mode

/**
 * A streamed answer from the Responses API (server-sent events). onText gets the answer's text so far each time
 * more of it arrives. → the finished response, the same object a call without streaming returns.
 */
async function readStream(res, label, onText) {
  const decoder = new TextDecoder();
  let buffer = '', text = '', done = null;
  const take = (block) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let e; try { e = JSON.parse(data); } catch { return; }
    if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') { text += e.delta; try { onText(text); } catch { /* the listener's problem, not the answer's */ } }
    else if (e.type === 'response.completed' || e.type === 'response.incomplete') done = e.response;
    else if (e.type === 'response.failed') throw new Error(`${label} failed: ${String(e.response?.error?.message || 'no reason given').slice(0, 300)}`);
    else if (e.type === 'error') throw new Error(`${label} failed: ${String(e.message || e.error?.message || 'no reason given').slice(0, 300)}`);
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) { const block = buffer.slice(0, at); buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, ''); take(block); }
  }
  if (buffer.trim()) take(buffer);
  if (!done) throw new Error(`${label} stopped before the answer was finished`);
  return done;
}
function reasoningOf(key, effort, wantThinking) {
  const r = { ...(effort && !noEffort.has(key) ? { effort } : {}), ...(wantThinking && !noThinking.has(key) ? { summary: 'auto' } : {}) };
  return Object.keys(r).length ? { reasoning: r } : {};
}

/** OpenAI's Responses API. messages: [{ role: 'system'|'user'|'assistant', content }] (system notes may come late). */
async function responses(p, messages, { model, temperature, maxTokens, schema, schemaName, wantThinking = false, effort = null, onText = null, fast = false }) {
  const base = process.env[p.base] || p.defaultBase;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  const t0 = performance.now();
  try {
    for (let attempt = 0; ; attempt++) {
      // With onText the answer is streamed: its text is handed over as it is written, so its first part can be used early.
      const stream = !!onText && !noStream.has(`${p.label}/${model}`);
      const res = await fetch(`${base}/responses`, {
        method: 'POST', signal: ctrl.signal,
        headers: { authorization: `Bearer ${process.env[p.key]}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, store: false, ...(stream ? { stream: true } : {}),
          // Fast mode: quicker and steadier, at a higher price per token (the models that have it).
          ...(fast && !noFast.has(`${p.label}/${model}`) ? { service_tier: 'fast' } : {}),
          input: messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
          ...(noTemperature.has(`${p.label}/${model}`) ? {} : { temperature }),
          // How hard to think (none, low, medium, high), when asked. The thinking itself isn't shared, but a
          // summary of it can be (for the admin's log).
          ...(reasoningOf(`${p.label}/${model}`, effort, wantThinking)),
          // Thinking counts towards this limit on models that think first, so leave room for it.
          max_output_tokens: maxTokens + 2000,
          text: { format: schema ? { type: 'json_schema', name: schemaName, strict: true, schema: z.toJSONSchema(schema, { target: 'draft-7' }) } : { type: 'json_object' } },
        }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        if (res.status === 400 && /temperature/i.test(body) && !noTemperature.has(`${p.label}/${model}`)) { noTemperature.add(`${p.label}/${model}`); continue; }
        // A model that doesn't take a thinking level, or doesn't share a summary: ask again without, and remember.
        if (res.status === 400 && effort && /effort/i.test(body) && !noEffort.has(`${p.label}/${model}`)) { noEffort.add(`${p.label}/${model}`); continue; }
        if (res.status === 400 && wantThinking && /reasoning|summary/i.test(body) && !noThinking.has(`${p.label}/${model}`)) { noThinking.add(`${p.label}/${model}`); continue; }
        if (res.status === 400 && stream && /stream/i.test(body)) { noStream.add(`${p.label}/${model}`); continue; }
        if (res.status === 400 && fast && /service_tier|tier/i.test(body) && !noFast.has(`${p.label}/${model}`)) { noFast.add(`${p.label}/${model}`); continue; }
        throw new Error(`${p.label} ${res.status}: ${body.slice(0, 300)}`);
      }
      let firstTextMs = null;
      const j = stream ? await readStream(res, p.label, (text) => { firstTextMs ??= Math.round(performance.now() - t0); onText(text); }) : await res.json();
      const thinking = (j.output || []).filter((o) => o.type === 'reasoning').flatMap((o) => o.summary || []).map((x) => x.text).filter(Boolean).join('\n').trim();
      const parts = (j.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
      const refused = parts.find((c) => c.type === 'refusal');
      if (refused) throw new Error(`${p.label} declined to answer: ${String(refused.refusal || '').slice(0, 200)}`);
      const text = parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      if (!text) throw new Error(`${p.label} gave no answer${j.status === 'incomplete' ? ` (${j.incomplete_details?.reason || 'incomplete'})` : ''}`);
      const u = j.usage || {};
      // tier: the speed the request was really served at (a Fast request can be served at standard speed and price).
      return { text, thinking: thinking || null, firstTextMs, tier: j.service_tier ?? null, usage: { input: u.input_tokens ?? null, cached: u.input_tokens_details?.cached_tokens ?? null, output: u.output_tokens ?? null, reasoning: u.output_tokens_details?.reasoning_tokens ?? null } };
    }
  } finally { clearTimeout(timer); }
}

export const openaiConfigured = () => !!process.env.OPENAI_API_KEY;
export const openaiChat = (messages, opts) => responses(PROVIDERS.openai, messages, opts);
// Through Vertex AI (the default) there is no key to check: a missing sign-in or permission shows on the first call.
export const geminiConfigured = () => vertexOn() || !!process.env.GEMINI_API_KEY;
export const geminiChat = (messages, opts) => chatCompletions(PROVIDERS.gemini, messages, opts);
