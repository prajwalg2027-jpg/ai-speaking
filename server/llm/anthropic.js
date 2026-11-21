// Claude as an optional provider (off unless chosen in the admin settings AND ANTHROPIC_API_KEY is set on the
// server), through the official SDK. Asks for structured output (a JSON schema generated from the Zod schema).
// Not exercised against the live API in this repository's tests (no key): test/llm-providers.test.js runs it
// against a fake server (ANTHROPIC_BASE_URL, which the SDK reads itself).
//
// Current models (claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5) reject temperature/top_p/top_k, thinking
// budgets, and (Sonnet 5.5, Opus 5.5) thinking: disabled. So none are sent: thinking stays on by default and
// `output_config.effort` keeps it short (ANTHROPIC_EFFORT, default low, for fast replies).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export const anthropicConfigured = () => !!process.env.ANTHROPIC_API_KEY;

// Models where a policy decline is re-run server-side on Anthropic's recommended fallback model. Not Haiku 5.5:
// it has no server-side fallback (a list of fallback models is a 400 there).
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Structured outputs need `additionalProperties: false` on every object and don't support numeric, string-length
// or array-size limits. Zod checks those limits on the answer anyway, so they are dropped from what is sent.
const UNSUPPORTED = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems']);
export function claudeSchema(node) {
  if (Array.isArray(node)) return node.map(claudeSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED.has(k)) continue;
    // `properties` and `$defs` map names to schemas: keep the names, clean each schema.
    out[k] = (k === 'properties' || k === '$defs' || k === 'definitions') ? Object.fromEntries(Object.entries(v).map(([n, s]) => [n, claudeSchema(s)])) : claudeSchema(v);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

let client = null, clientKey = '';
function getClient() {
  const key = `${process.env.ANTHROPIC_API_KEY}|${process.env.ANTHROPIC_BASE_URL || ''}`;
  if (!client || key !== clientKey) {
    // The SDK retries 429 and 5xx itself (2 retries, with backoff); timeout is per attempt, in milliseconds.
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, timeout: 20_000, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

/** messages in OpenAI shape → { text (the JSON string), usage: { input, output, reasoning } } */
export async function anthropicChat(messages, { model, maxTokens = 900, schema, schemaName = 'answer' }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const params = {
    model,
    // Thinking counts toward max_tokens, so leave room for it on top of the answer (as server/sarvam.js does).
    max_tokens: maxTokens + 1024,
    ...(system ? { system } : {}),
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: String(m.content ?? '') })),
    output_config: {
      effort: process.env.ANTHROPIC_EFFORT || 'low',
      ...(schema ? { format: { type: 'json_schema', schema: claudeSchema(z.toJSONSchema(schema)) } } : {}),
    },
    ...(FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  };
  let res;
  try {
    res = await getClient().beta.messages.create(params);
  } catch (e) {
    // Most specific first. A timeout is reported as AbortError so the caller files it as a timeout.
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw Object.assign(new Error('Claude timed out'), { name: 'AbortError' });
    if (e instanceof Anthropic.APIConnectionError) throw new Error(`Claude unreachable: ${e.message}`);
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key (ANTHROPIC_API_KEY)');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit reached (after retries)');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude ${e.status ?? 'error'}: ${String(e.message).slice(0, 300)}`);
    throw e;
  }
  // stop_reason first: a refusal comes back as a normal 200 with empty or partial content.
  if (res.stop_reason === 'refusal') {
    const why = res.stop_details?.category ? ` (${res.stop_details.category})` : '';
    throw new Error(`Claude declined to answer${why}`);
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (res.stop_reason === 'max_tokens' && !text) throw new Error('Claude used up max_tokens before answering (thinking took it all)');
  const u = res.usage || {};
  const input = u.input_tokens == null ? null : u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  // Claude's output_tokens include thinking; the API doesn't split it out, so reasoning is unknown.
  return { text, usage: { input, output: u.output_tokens ?? null, reasoning: null } };
}
