// OpenAI and Gemini as optional providers (off unless switched on in the admin settings AND the provider's key is
// set on the server). Both speak the OpenAI chat-completions format (Gemini through Google's OpenAI-compatible
// endpoint), so one request function serves both. Uses native structured outputs (a strict JSON schema generated
// from the Zod schema).
// Not exercised against the live APIs in this repository's tests (no keys): see docs/LEARNING.md.
import { z } from 'zod';

// Base URL and key are read at call time, so tests (and a changed env) take effect without a re-import.
const PROVIDERS = {
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL', defaultBase: 'https://api.openai.com/v1', maxParam: 'max_completion_tokens' },
  gemini: { label: 'Gemini', key: 'GEMINI_API_KEY', base: 'GEMINI_BASE_URL', defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai', maxParam: 'max_tokens' },
};

// Models that refused a temperature (newer OpenAI models accept only their default): not sent to them again.
const noTemperature = new Set();

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

export const openaiConfigured = () => !!process.env.OPENAI_API_KEY;
export const openaiChat = (messages, opts) => chatCompletions(PROVIDERS.openai, messages, opts);
export const geminiConfigured = () => !!process.env.GEMINI_API_KEY;
export const geminiChat = (messages, opts) => chatCompletions(PROVIDERS.gemini, messages, opts);
