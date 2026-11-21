// The AI providers against fake servers (no keys, no network): Claude through the official SDK (Messages API) and
// Gemini through an OpenAI-compatible API. Checks the request each provider sends, refusals, `structured({ config })`,
// `timeoutMs`, and the cost estimate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';

const Answer = z.strictObject({ reply: z.string().min(1).max(200), score: z.number().int().min(0).max(5) });
const ANSWER = { reply: 'Well done!', score: 4 };
let claudeFake, openFake, llm, anthropic, prices;
const claudeCalls = [], openCalls = [];

/** A fake server: records each request, answers with `respond(body, req)` → [status, json, delayMs?]. */
function startFake(calls, respond) {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      let raw = ''; for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, headers: req.headers, body });
      const [code, json, delay = 0] = respond(body, req);
      setTimeout(() => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); }, delay);
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}
const lastUser = (b) => JSON.stringify(b.messages.at(-1).content);
const claudeMessage = (model, extra) => ({ id: 'msg_1', type: 'message', role: 'assistant', model, stop_details: null, usage: { input_tokens: 1000, output_tokens: 200 }, ...extra });

before(async () => {
  claudeFake = await startFake(claudeCalls, (b) => {
    if (lastUser(b).includes('REFUSE')) return [200, claudeMessage(b.model, { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } })];
    return [200, claudeMessage(b.model, { content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: JSON.stringify(ANSWER) }], stop_reason: 'end_turn' })];
  });
  openFake = await startFake(openCalls, (b) => [200, { choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }, lastUser(b).includes('SLOW') ? 600 : 0]);
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'claude-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudeFake.address().port}`,
    GEMINI_API_KEY: 'gemini-test-key', GEMINI_BASE_URL: `http://127.0.0.1:${openFake.address().port}/gemini`,
    OPENAI_API_KEY: 'openai-test-key', OPENAI_BASE_URL: `http://127.0.0.1:${openFake.address().port}/openai`,
    USD_INR: '88',
  });
  delete process.env.ANTHROPIC_EFFORT;
  delete process.env.SARVAM_API_KEY; // the settings' Sarvam default must look unconfigured here
  llm = await import('../server/llm/index.js');
  anthropic = await import('../server/llm/anthropic.js');
  prices = await import('../server/llm/prices.js');
});
after(() => { for (const s of [claudeFake, openFake]) { s?.closeAllConnections(); s?.close(); } });

const messages = [{ role: 'system', content: 'You are a kind English tutor.' }, { role: 'user', content: 'I goed to school.' }];

test('Claude: structured JSON that validates, and the request it sends', async () => {
  claudeCalls.length = 0;
  const r = await llm.structured({ job: 'placement', config: { provider: 'anthropic', model: 'claude-sonnet-5-5', temperature: 0.6 }, messages, schema: Answer, schemaName: 'feedback' });
  assert.deepEqual(r.data, ANSWER);
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.usage, { input: 1000, output: 200, reasoning: 0 });
  assert.equal(claudeCalls.length, 1);
  const { path, headers, body } = claudeCalls[0];
  assert.match(path, /^\/v1\/messages/);
  // The SDK (1.x) sends the API key as `Authorization: Bearer`; older majors used `x-api-key`. Either carries the key.
  assert.ok(headers['x-api-key'] === 'claude-test-key' || headers.authorization === 'Bearer claude-test-key', 'API key sent');
  assert.match(headers['anthropic-version'], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.system, 'You are a kind English tutor.');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'I goed to school.' }]);
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(k in body, false, `${k} must not be sent`);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  const schema = body.output_config.format.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ['reply', 'score']);
  assert.equal(JSON.stringify(schema).match(/minLength|maxLength|minimum|maximum/), null, 'unsupported limits are dropped');
  // Server-side refusal fallback on Sonnet 5.5 / Opus 5.5.
  assert.equal(body.fallbacks, 'default');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.ok(body.max_tokens > 900, 'room for thinking');
});

test('Claude Haiku 5.5: no fallbacks (it has none)', async () => {
  claudeCalls.length = 0;
  await anthropic.anthropicChat(messages, { model: 'claude-haiku-5-5', maxTokens: 500, schema: Answer });
  const { headers, body } = claudeCalls[0];
  assert.equal('fallbacks' in body, false);
  assert.doesNotMatch(headers['anthropic-beta'] || '', /server-side-fallback/);
});

test('Claude: a refusal throws, directly and through structured()', async () => {
  const refused = [{ role: 'user', content: 'REFUSE this' }];
  await assert.rejects(anthropic.anthropicChat(refused, { model: 'claude-opus-5-5', schema: Answer }), /declined to answer \(cyber\)/);
  await assert.rejects(llm.structured({ job: 'x', config: { provider: 'anthropic', model: 'claude-opus-5-5' }, messages: refused, schema: Answer }),
    (e) => e instanceof llm.LlmError && e.kind === 'provider' && /declined/.test(e.message));
});

test('Gemini: its own base URL and key, max_tokens', async () => {
  openCalls.length = 0;
  const r = await llm.structured({ job: 'x', config: { provider: 'gemini', model: 'gemini-3-flash', temperature: 0.2 }, messages, schema: Answer });
  assert.deepEqual(r.data, ANSWER);
  assert.equal(r.provider, 'gemini');
  const { path, headers, body } = openCalls[0];
  assert.equal(path, '/gemini/chat/completions');
  assert.equal(headers.authorization, 'Bearer gemini-test-key');
  assert.equal(body.model, 'gemini-3-flash');
  assert.equal(body.max_tokens, 900);
  assert.equal('max_completion_tokens' in body, false);
  assert.equal(body.response_format.type, 'json_schema');
});

test('OpenAI still goes to its own URL with its own key', async () => {
  openCalls.length = 0;
  const { openaiChat } = await import('../server/llm/openai.js');
  await openaiChat(messages, { model: 'gpt-x', temperature: 0, maxTokens: 300, schema: Answer, schemaName: 'a' });
  assert.equal(openCalls[0].path, '/openai/chat/completions');
  assert.equal(openCalls[0].headers.authorization, 'Bearer openai-test-key');
  assert.equal(openCalls[0].body.max_completion_tokens, 300);
});

test('structured({ config }) overrides the settings for the job', async () => {
  openCalls.length = 0; claudeCalls.length = 0;
  // The settings say Sarvam for `tutor` (not configured here, so without config this would fail).
  await assert.rejects(llm.structured({ job: 'tutor', messages, schema: Answer }), (e) => e.kind === 'config');
  const r = await llm.structured({ job: 'tutor', config: { provider: 'gemini', model: 'gemini-x', temperature: 0.1 }, messages, schema: Answer });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.model, 'gemini-x');
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].body.temperature, 0.1);
});

test('timeoutMs rejects with kind timeout', async () => {
  const t0 = Date.now();
  await assert.rejects(llm.structured({ job: 'x', config: { provider: 'gemini', model: 'g', temperature: 0 }, timeoutMs: 100, messages: [{ role: 'user', content: 'SLOW' }], schema: Answer }),
    (e) => e instanceof llm.LlmError && e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 500);
});

test('costInr: Claude priced, unknown model null', async () => {
  // Sonnet 5.5: $2 in / $10 out per million → (1000*2 + 200*10)/1e6 = $0.004 → ₹0.352 at 88.
  assert.ok(Math.abs(prices.costInr({ provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input: 1000, output: 200 } }) - 0.352) < 1e-9);
  assert.equal(prices.costInr({ provider: 'anthropic', model: 'claude-unknown', usage: { input: 1000, output: 200 } }), null);
  assert.equal(prices.costInr({ provider: 'gemini', model: 'gemini-x', usage: { input: 1000, output: 200 } }), null);
  assert.equal(typeof prices.costInr({ provider: 'sarvam', model: 'sarvam-105b', usage: { input: 1000, output: 200 } }), 'number');
  const r = await llm.structured({ job: 'x', config: { provider: 'anthropic', model: 'claude-haiku-5-5' }, messages, schema: Answer });
  assert.ok(Math.abs(r.costInr - (1000 * 0.1 + 200 * 0.5) / 1e6 * 88) < 1e-9);
});
