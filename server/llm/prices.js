// What one AI call cost, in rupees, estimated from its token usage. null when the model's price isn't known here
// (Gemini models, or a model not listed): better no number than a wrong one.
// Sarvam prices come from server/costs.js (rupees, set in .env). Claude and OpenAI prices are list prices in US
// dollars per million tokens (standard rate, no batch or priority tiers), converted at USD_INR (default 88).
import { PRICES } from '../costs.js';

const CLAUDE_USD_PER_MILLION = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 }, // prompts up to 100K tokens; longer ones cost more
  'claude-sonnet-5-5': { input: 2, cached: 0.10, output: 10 },
  'claude-opus-5-5': { input: 4, cached: 0.20, output: 20 },
};

// OpenAI's Standard tier, read once from https://developers.openai.com/api/docs/pricing on 22 Nov 2026 (the
// page's own data, every text model it lists). Where a model has two context sizes, the smaller one's rate.
// "cached" is the price of input tokens the provider reused. Prices change: re-read the page to update.
export const OPENAI_PRICES_AS_OF = '22 Nov 2026';
const OPENAI_USD_PER_MILLION = {
  'gpt-6.2-astra': { input: 8, cached: 0.4, output: 40 },
  'gpt-6.2-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.5-pro': { input: 30, output: 180 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30, output: 180 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.2-pro': { input: 21, output: 168 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-5-pro': { input: 15, output: 120 },
  'gpt-4.1': { input: 2, cached: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'o3-pro': { input: 20, output: 80 },
  'o3': { input: 2, cached: 0.5, output: 8 },
};
const USD_TABLES = { anthropic: CLAUDE_USD_PER_MILLION, openai: OPENAI_USD_PER_MILLION };

/** A model's listed price in US dollars per million tokens, or null. A dated name ("gpt-6-luna-2026-10-01") takes its model's price. */
export function usdPrice(provider, model) {
  const table = USD_TABLES[provider];
  if (!table || !model) return null;
  if (table[model]) return table[model];
  const base = Object.keys(table).filter((k) => model.startsWith(`${k}-`)).sort((x, y) => y.length - x.length)[0];
  return base ? table[base] : null;
}

/** Every price known here, for the admin's model menus: { provider: { model: { input, cached?, output } } } in US dollars per million tokens. */
export const knownPrices = () => ({ ...USD_TABLES, sarvamInr: PRICES.llmPerMillion, usdInr: usdInr(), openaiAsOf: OPENAI_PRICES_AS_OF });

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
  else if (usdPrice(provider, model)) perM = inr(usdPrice(provider, model), usdInr());
  else return null;
  return (input * perM.input + cached * perM.cached + output * perM.output) / 1e6;
}
