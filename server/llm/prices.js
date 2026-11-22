// What one AI call cost, in rupees, estimated from its token usage. null when the model's price isn't known here
// (OpenAI and Gemini models, or a Claude model not listed): better no number than a wrong one.
// Sarvam prices come from server/costs.js (rupees, set in .env). Claude prices are list prices in US dollars per
// million tokens (standard rate, no caching or batch discounts), converted at USD_INR (default 88).
import { PRICES } from '../costs.js';

const CLAUDE_USD_PER_MILLION = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 }, // prompts up to 100K tokens; longer ones cost more
  'claude-sonnet-5-5': { input: 2, cached: 0.10, output: 10 },
  'claude-opus-5-5': { input: 4, cached: 0.20, output: 20 },
};

function usdInr() {
  const n = Number(process.env.USD_INR);
  return Number.isFinite(n) && n > 0 ? n : 88;
}

/**
 * usage: { input (all input tokens, the cached ones included), cached, output (reasoning included) }.
 * price: optional { input, cached?, output } in US dollars per million tokens, for a model whose price isn't
 * known here (typed on the admin's Compare models page). Cached tokens cost the input price unless given.
 * @returns {number|null} rupees
 */
export function costInr({ provider, model, usage, price = null }) {
  if (!usage || (usage.input == null && usage.output == null)) return null;
  const cached = Math.min(usage.cached || 0, usage.input || 0), input = (usage.input || 0) - cached, output = usage.output || 0;
  const inr = (p, rate) => ({ input: p.input * rate, cached: (p.cached ?? p.input) * rate, output: p.output * rate });
  let perM;
  if (price && Number.isFinite(price.input) && Number.isFinite(price.output)) perM = inr(price, usdInr());
  else if (provider === 'sarvam') perM = inr(PRICES.llmPerMillion, 1);
  else if (provider === 'anthropic' && CLAUDE_USD_PER_MILLION[model]) perM = inr(CLAUDE_USD_PER_MILLION[model], usdInr());
  else return null;
  return (input * perM.input + cached * perM.cached + output * perM.output) / 1e6;
}
