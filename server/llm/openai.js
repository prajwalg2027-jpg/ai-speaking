// OpenAI and Gemini as optional providers (off unless switched on in the admin settings AND the provider's key is
// set on the server). OpenAI is called through its Responses API (POST /responses: the conversation goes in
// `input`, the JSON shape in `text.format`). Gemini is called through Google's OpenAI-compatible chat-completions
// endpoint. Both use native structured outputs (a strict JSON schema generated from the Zod schema).
// Requests are stateless: the whole talk is sent each time and nothing is stored at the provider (`store: false`).
// The talk only grows from turn to turn, so the provider reuses the repeated part (prompt caching) by itself.
// Not exercised against the live APIs in this repository's tests (no keys): see docs/LEARNING.md.
import { z } from 'zod';

// Base URL and key are read at call time, so tests (and a changed env) take effect without a re-import.
const PROVIDERS = {
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL', defaultBase: 'https://api.openai.com/v1', maxParam: 'max_completion_tokens' },
  gemini: { label: 'Gemini', key: 'GEMINI_API_KEY', base: 'GEMINI_BASE_URL', defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai', maxParam: 'max_tokens' },
};

// Models that refused a temperature (newer OpenAI models accept only their default): not sent to them again.
const noTemperature = new Set();
// Models that refused a request for a summary of their thinking (they don't think, or the account can't see it).
const noThinking = new Set();

async function chatCompletions(p, messages, { model, temperature, maxTokens, schema, schemaName }) {
  const base = process.env[p.base] || p.defaultBase;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { authorization: `Bearer ${process.env[p.key]}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, messages, ...(noTemperature.has(`${p.label}/${model}`) ? {} : { temperature }), [p.maxParam]: maxTokens,
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
        throw new Error(`${p.label} ${res.status}: ${body.slice(0, 300)}`);
      }
      const j = await res.json();
      const u = j.usage || {};
      return { text: j.choices?.[0]?.message?.content ?? '', usage: { input: u.prompt_tokens ?? null, cached: u.prompt_tokens_details?.cached_tokens ?? null, output: u.completion_tokens ?? null, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null } };
    }
  } finally { clearTimeout(timer); }
}

const noEffort = new Set(); // models that refused a thinking level
function reasoningOf(key, effort, wantThinking) {
  const r = { ...(effort && !noEffort.has(key) ? { effort } : {}), ...(wantThinking && !noThinking.has(key) ? { summary: 'auto' } : {}) };
  return Object.keys(r).length ? { reasoning: r } : {};
}

/** OpenAI's Responses API. messages: [{ role: 'system'|'user'|'assistant', content }] (system notes may come late). */
async function responses(p, messages, { model, temperature, maxTokens, schema, schemaName, wantThinking = false, effort = null }) {
  const base = process.env[p.base] || p.defaultBase;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}/responses`, {
        method: 'POST', signal: ctrl.signal,
        headers: { authorization: `Bearer ${process.env[p.key]}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, store: false,
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
        throw new Error(`${p.label} ${res.status}: ${body.slice(0, 300)}`);
      }
      const j = await res.json();
      const thinking = (j.output || []).filter((o) => o.type === 'reasoning').flatMap((o) => o.summary || []).map((x) => x.text).filter(Boolean).join('\n').trim();
      const parts = (j.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
      const refused = parts.find((c) => c.type === 'refusal');
      if (refused) throw new Error(`${p.label} declined to answer: ${String(refused.refusal || '').slice(0, 200)}`);
      const text = parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      if (!text) throw new Error(`${p.label} gave no answer${j.status === 'incomplete' ? ` (${j.incomplete_details?.reason || 'incomplete'})` : ''}`);
      const u = j.usage || {};
      return { text, thinking: thinking || null, usage: { input: u.input_tokens ?? null, cached: u.input_tokens_details?.cached_tokens ?? null, output: u.output_tokens ?? null, reasoning: u.output_tokens_details?.reasoning_tokens ?? null } };
    }
  } finally { clearTimeout(timer); }
}

export const openaiConfigured = () => !!process.env.OPENAI_API_KEY;
export const openaiChat = (messages, opts) => responses(PROVIDERS.openai, messages, opts);
export const geminiConfigured = () => !!process.env.GEMINI_API_KEY;
export const geminiChat = (messages, opts) => chatCompletions(PROVIDERS.gemini, messages, opts);
