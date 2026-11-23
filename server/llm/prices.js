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
// OpenAI's Fast mode (service_tier "fast": up to 2.5 times faster, at a higher price per token), from the same
// page on the same day. Only these models have it.
const OPENAI_FAST_USD_PER_MILLION = {
  'gpt-6.2-astra': { input: 16, cached: 0.8, output: 80 },
  'gpt-6.2-sol': { input: 4, cached: 0.2, output: 20 },
  'gpt-6-astra': { input: 20, cached: 2, output: 100 },
  'gpt-6.1-sol': { input: 4, cached: 0.2, output: 20 },
  'gpt-6.1-terra': { input: 2, cached: 0.1, output: 10 },
  'gpt-6-luna': { input: 0.2, cached: 0.02, output: 1 },
  'gpt-6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-sol': { input: 8, cached: 0.8, output: 40 },
  'gpt-5.6-terra': { input: 4, cached: 0.4, output: 24 },
  'gpt-5.6-luna': { input: 0.4, cached: 0.04, output: 2.4 },
};
// Gemini (Google), standard tier, from Google's price page (aistudio.google.com/docs/pricing) on 23 Nov 2026.
// Some prices rise on a date Google has announced: "later" holds the new price and the day it starts, and the
// right one is used for the day the call is made. "cached" is the price of reused input (Google's context caching).
export const GEMINI_PRICES_AS_OF = '23 Nov 2026';
const GEMINI_USD_PER_MILLION = {
  'gemini-4-carbon': { input: 2, cached: 0.1, output: 10, later: { from: '2026-12-01', input: 4, cached: 0.2, output: 20 } },
  'gemini-4-argon': { input: 2, cached: 0.1, output: 10, later: { from: '2026-12-01', input: 4, cached: 0.2, output: 20 } },
  'gemini-4-neon': { input: 3, cached: 0.15, output: 15 },
  'gemini-4-hydrogen': { input: 1.5, cached: 0.075, output: 7.5 },
  'gemini-3.8-flash': { input: 0.75, cached: 0.075, output: 3.75, later: { from: '2027-01-01', input: 1.5, cached: 0.15, output: 7.5 } },
  'gemini-3.6-flash': { input: 0.75, cached: 0.075, output: 3.75, later: { from: '2027-01-01', input: 1.5, cached: 0.15, output: 7.5 } },
  'gemini-3.5-flash-lite': { input: 0.3, cached: 0.03, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, cached: 0.025, output: 1.5 },
  'gemini-3.1-pro-preview': { input: 2, cached: 0.2, output: 12 }, // prompts up to 200k tokens
  'gemini-3-flash-preview': { input: 0.5, cached: 0.05, output: 3 },
  'gemini-2.5-pro': { input: 1.25, cached: 0.125, output: 10 }, // prompts up to 200k tokens
  'gemini-2.5-flash': { input: 0.3, cached: 0.03, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, cached: 0.01, output: 0.4 },
};
/** The price that applies on a day: a model's own, or its "later" one once that has started. */
const onDay = (p, day = new Date().toISOString().slice(0, 10)) => (p?.later && day >= p.later.from ? p.later : p) || null;
const USD_TABLES = { anthropic: CLAUDE_USD_PER_MILLION, openai: OPENAI_USD_PER_MILLION, gemini: GEMINI_USD_PER_MILLION };
/** Was this answer served in OpenAI's Fast mode? (Older models report it as "priority".) */
export const isFastTier = (tier) => tier === 'fast' || tier === 'priority';

/** A model's listed price in US dollars per million tokens, or null. A dated name ("gpt-6-luna-2026-10-01") takes its model's price. */
export function usdPrice(provider, model, tier = null) {
  const table = provider === 'openai' && isFastTier(tier) ? OPENAI_FAST_USD_PER_MILLION : USD_TABLES[provider];
  if (!table || !model) return null;
  if (table[model]) return onDay(table[model]);
  const base = Object.keys(table).filter((k) => model.startsWith(`${k}-`)).sort((x, y) => y.length - x.length)[0];
  return base ? onDay(table[base]) : null;
}

/** Every price known here, for the admin's model menus: { provider: { model: { input, cached?, output } } } in US dollars per million tokens. */
export const knownPrices = () => ({ ...Object.fromEntries(Object.entries(USD_TABLES).map(([p, t]) => [p, Object.fromEntries(Object.entries(t).map(([m, x]) => [m, onDay(x)]))])), openaiFast: OPENAI_FAST_USD_PER_MILLION, geminiAsOf: GEMINI_PRICES_AS_OF, sarvamInr: PRICES.llmPerMillion, usdInr: usdInr(), openaiAsOf: OPENAI_PRICES_AS_OF });

function usdInr() {
  const n = Number(process.env.USD_INR);
  return Number.isFinite(n) && n > 0 ? n : 88;
}

/**
 * usage: { input (all input tokens, the cached ones included), cached, output (reasoning included) }.
 * price: optional { input, cached?, output } in US dollars per million tokens, for a model whose price isn't
 * known here (typed on the admin's Compare models page). Cached tokens cost the input price unless given.
 * tier: the service tier the provider says it used (OpenAI's "fast" costs more).
 * @returns {number|null} rupees
 */
export function costInr({ provider, model, usage, price = null, tier = null }) {
  if (!usage || (usage.input == null && usage.output == null)) return null;
  const cached = Math.min(usage.cached || 0, usage.input || 0), input = (usage.input || 0) - cached, output = usage.output || 0;
  const inr = (p, rate) => ({ input: p.input * rate, cached: (p.cached ?? p.input) * rate, output: p.output * rate });
  let perM;
  if (price && Number.isFinite(price.input) && Number.isFinite(price.output)) perM = inr(price, usdInr());
  else if (provider === 'sarvam') perM = inr(PRICES.llmPerMillion, 1);
  else if (usdPrice(provider, model, tier)) perM = inr(usdPrice(provider, model, tier), usdInr());
  else return null;
  return (input * perM.input + cached * perM.cached + output * perM.output) / 1e6;
}
