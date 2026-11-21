// What one AI call cost, in rupees, estimated from its token usage. null when the model's price isn't known here
// (OpenAI and Gemini models, or a Claude model not listed): better no number than a wrong one.
// Sarvam prices come from server/costs.js (rupees, set in .env). Claude prices are list prices in US dollars per
// million tokens (standard rate, no caching or batch discounts), converted at USD_INR (default 88).
import { PRICES } from '../costs.js';

const CLAUDE_USD_PER_MILLION = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 }, // prompts up to 100K tokens; longer ones cost more
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

function usdInr() {
  const n = Number(process.env.USD_INR);
  return Number.isFinite(n) && n > 0 ? n : 88;
}

/** @returns {number|null} rupees */
export function costInr({ provider, model, usage }) {
  if (!usage || (usage.input == null && usage.output == null)) return null;
  const input = usage.input || 0, output = usage.output || 0; // reasoning tokens are already part of output
  let perM;
  if (provider === 'sarvam') perM = PRICES.llmPerMillion;
  else if (provider === 'anthropic' && CLAUDE_USD_PER_MILLION[model]) {
    const p = CLAUDE_USD_PER_MILLION[model], r = usdInr();
    perM = { input: p.input * r, output: p.output * r };
  } else return null;
  return (input * perM.input + output * perM.output) / 1e6;
}
