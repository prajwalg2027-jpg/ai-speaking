// OpenAI as an optional provider (off unless switched on in the admin settings AND OPENAI_API_KEY is set on the
// server). Uses native structured outputs (a strict JSON schema generated from the Zod schema).
// Not exercised against the live API in this repository's tests (no key): see docs/LEARNING.md.
import { z } from 'zod';

const BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
export const openaiConfigured = () => !!process.env.OPENAI_API_KEY;

export async function openaiChat(messages, { model, temperature, maxTokens, schema, schemaName }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, messages, temperature, max_completion_tokens: maxTokens,
          response_format: schema
            ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: z.toJSONSchema(schema, { target: 'draft-7' }) } }
            : { type: 'json_object' },
        }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      const u = j.usage || {};
      return { text: j.choices?.[0]?.message?.content ?? '', usage: { input: u.prompt_tokens ?? null, output: u.completion_tokens ?? null, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null } };
    }
  } finally { clearTimeout(timer); }
}
