import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLedger, summarize, withLedger, addChat, addVoice, addSpeechToText, PRICES } from '../server/costs.js';

test('rupees: speech per hour, voice per 10K characters, tokens per million (cached input cheaper)', () => {
  const l = makeLedger();
  withLedger(l, () => {
    addChat({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 400_000 }, completion_tokens_details: { reasoning_tokens: 300_000 } }, 'tutor');
    addVoice(10_000, { cached: false });
    addVoice(5_000, { cached: true }); // from the cache: free
  });
  addSpeechToText(l, 3600);
  const c = summarize(l);
  const P = PRICES.llmPerMillion;
  assert.equal(c.stt.inr, PRICES.sttPerHour);
  assert.equal(c.tts.inr, PRICES.ttsPer10kChars);
  assert.equal(c.tts.cachedChars, 5000);
  assert.ok(Math.abs(c.llm.inr - (0.6 * P.input + 0.4 * P.cached + P.output)) < 1e-9);
  assert.equal(c.llm.byPurpose.tutor.reasoning, 300_000);
  assert.ok(Math.abs(c.totalInr - (c.stt.inr + c.tts.inr + c.llm.inr)) < 1e-9);
});
