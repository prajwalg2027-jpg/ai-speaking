// What a conversation costs in Sarvam API charges, in rupees.
//
// Every Sarvam call made while handling a conversation is added to that conversation's ledger:
//   - speech-to-text: seconds of audio the relay sends to Sarvam Realtime (including the silence it pushes
//     when the learner taps "Done"), billed per hour of audio
//   - voice: characters sent to Bulbul. Lines already in the server's voice cache aren't sent again, so they
//     cost nothing for this conversation
//   - LLM: tokens from each chat call's `usage` (understand, scoring, tutor; speculative replies that are
//     thrown away are billed too). Reasoning tokens are part of the output tokens
// Calls made outside a conversation (the voice cache filled at startup, the STT lab) go to a shared ledger.
//
// Prices are an estimate, excluding GST. They change: set them in .env (see PRICES below).
import { AsyncLocalStorage } from 'node:async_hooks';

const num = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== '' ? Number(process.env[name]) : fallback);

export const PRICES = {
  currency: 'INR',
  asOf: process.env.PRICES_AS_OF || 'Nov 2026',
  sttPerHour: num('PRICE_STT_PER_HOUR', 30),              // Saaras speech-to-text, per hour of audio
  ttsPer10kChars: num('PRICE_TTS_PER_10K_CHARS', 20),     // Bulbul v4 Flash, per 10,000 characters
  llmPerMillion: {                                        // Sarvam-105B (both variants), per 1M tokens
    input: num('PRICE_LLM_INPUT_PER_M', 15),
    cached: num('PRICE_LLM_CACHED_PER_M', 5),
    output: num('PRICE_LLM_OUTPUT_PER_M', 60),
  },
};

export function makeLedger() {
  return {
    sttSec: 0,
    tts: { calls: 0, chars: 0, cachedCalls: 0, cachedChars: 0 },
    llm: {}, // purpose → { calls, input, cached, output, reasoning }
  };
}

/** The ledger Sarvam calls are charged to: the conversation being handled, or the shared one. */
export const shared = makeLedger();
const context = new AsyncLocalStorage();
export const withLedger = (ledger, fn) => context.run(ledger, fn);
const current = () => context.getStore() || shared;

// Spend across every conversation today (India time), for the production daily cap (server/guard.js).
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daily = { day: today(), inr: 0 };
function charge(inr) { const d = today(); if (d !== daily.day) { daily.day = d; daily.inr = 0; } daily.inr += inr; }
export function spentToday() { charge(0); return daily.inr; }

export function addSpeechToText(ledger, seconds) { ledger.sttSec += seconds; charge((seconds / 3600) * PRICES.sttPerHour); }

export function addVoice(chars, { cached }) {
  const t = current().tts;
  if (cached) { t.cachedCalls++; t.cachedChars += chars; } else { t.calls++; t.chars += chars; charge((chars / 10_000) * PRICES.ttsPer10kChars); }
}

export function addChat(usage, purpose = 'other') {
  const l = current().llm;
  const p = (l[purpose] ||= { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });
  p.calls++;
  if (!usage) return;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  p.input += (usage.prompt_tokens || 0) - cached;
  p.cached += cached;
  p.output += usage.completion_tokens || 0;
  p.reasoning += usage.completion_tokens_details?.reasoning_tokens || 0;
  charge(llmInr({ input: (usage.prompt_tokens || 0) - cached, cached, output: usage.completion_tokens || 0 }));
}

const llmInr = (p) => (p.input * PRICES.llmPerMillion.input + p.cached * PRICES.llmPerMillion.cached + p.output * PRICES.llmPerMillion.output) / 1e6;

/** Rupee totals for a ledger. */
export function summarize(ledger) {
  const stt = { seconds: +ledger.sttSec.toFixed(1), inr: (ledger.sttSec / 3600) * PRICES.sttPerHour };
  const tts = { ...ledger.tts, inr: (ledger.tts.chars / 10_000) * PRICES.ttsPer10kChars };
  const byPurpose = Object.fromEntries(Object.entries(ledger.llm).map(([k, p]) => [k, { ...p, inr: llmInr(p) }]));
  const llm = Object.values(byPurpose).reduce((a, p) => ({
    calls: a.calls + p.calls, input: a.input + p.input, cached: a.cached + p.cached, output: a.output + p.output,
    reasoning: a.reasoning + p.reasoning, inr: a.inr + p.inr,
  }), { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, inr: 0 });
  return { currency: 'INR', totalInr: stt.inr + tts.inr + llm.inr, stt, tts, llm: { ...llm, byPurpose }, prices: PRICES };
}
