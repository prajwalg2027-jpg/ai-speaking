// Voices for Sakhi from two providers, for comparing them side by side (admin console › Compare voices):
//   Sarvam  Bulbul text-to-speech, the voice the app uses today (server/sarvam.js).
//   Google  Gemini text-to-speech (aistudio.google.com/docs/speech-generation), through the Interactions API.
// Each gives 24 kHz, 16-bit, mono sound, the same as the app plays. Nothing here is used by the app itself.
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { PRICES, addVoice } from '../costs.js';
import { voiceLanguage } from '../../shared/languages.js';

export const SAMPLE_RATE = 24000;
const usdInr = () => { const n = Number(process.env.USD_INR); return Number.isFinite(n) && n > 0 ? n : 88; };
const today = () => new Date().toISOString().slice(0, 10);
const onDay = (p) => (p?.later && today() >= p.later.from ? { ...p, ...p.later } : p);

// ---- what can be chosen -----------------------------------------------------------------------------
const SARVAM_VOICES = JSON.parse(readFileSync(new URL('./sarvam-voices.json', import.meta.url), 'utf8'));

// Sarvam: priced per 1,000 characters (docs.sarvam.ai pricing, pay as you go, 23 Nov 2026).
// Google: per million tokens in US dollars (aistudio.google.com/docs/pricing, standard tier, 23 Nov 2026); the
// sound is billed as output tokens, 25 for every second of it. Google has announced that its 3.8 prices double on
// 1 Jan 2027 ("later"); the price for the day is used.
export const MODELS = {
  sarvam: {
    'bulbul:v4-flash': { label: 'Bulbul v4 Flash (what the app uses)', inrPer1000Chars: () => PRICES.ttsPer10kChars / 10 },
    'bulbul:v3': { label: 'Bulbul v3', inrPer1000Chars: () => 3 },
  },
  gemini: {
    'gemini-3.8-flash-tts': { label: 'Gemini 3.8 Flash TTS', usd: { input: 0.5, output: 9, later: { from: '2027-01-01', input: 1, output: 18 } } },
    'gemini-3.8-flash-lite-tts': { label: 'Gemini 3.8 Flash-Lite TTS', usd: { input: 0.5, output: 6, later: { from: '2027-01-01', input: 1, output: 12 } } },
    'gemini-3.1-flash-tts-preview': { label: 'Gemini 3.1 Flash TTS (preview)', usd: { input: 1, output: 20 } },
    'gemini-2.5-flash-preview-tts': { label: 'Gemini 2.5 Flash TTS (preview)', usd: { input: 0.5, output: 10 } },
    'gemini-2.5-pro-preview-tts': { label: 'Gemini 2.5 Pro TTS (preview)', usd: { input: 1, output: 20 } },
  },
};
const AUDIO_TOKENS_PER_SECOND = 25;
// Google's 30 studio voices and what they sound like (its own words). More are in its voice library.
export const GEMINI_VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'],
  ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'], ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
].map(([id, sound]) => ({ id, label: `${id} (${sound})` }));

export const configured = { sarvam: () => !!config.sarvam.apiKey, gemini: () => !!process.env.GEMINI_API_KEY };
const geminiBase = () => process.env.GEMINI_NATIVE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

let libraryCache = { at: 0, list: null };
/** Google's wider voice library for English and Hindi (needs the key; kept for an hour). Studio voices if it can't be had. */
export async function geminiVoices() {
  if (!configured.gemini()) return GEMINI_VOICES;
  if (libraryCache.list && Date.now() - libraryCache.at < 60 * 60 * 1000) return libraryCache.list;
  try {
    const q = new URLSearchParams([['language_code', 'en-IN'], ['language_code', 'hi-IN'], ['page_size', '1000']]);
    const res = await fetch(`${geminiBase()}/voices?${q}`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const j = await res.json();
    const more = (j.voices || []).map((v) => {
      const id = String(v.voice || v.voice_id || v.id || v.name || '').replace(/^voices\//, '');
      const about = [v.gender, v.accent, v.persona, v.description].filter(Boolean).join(', ');
      return id && { id, label: `${v.display_name || v.displayName || id}${about ? ` (${about.slice(0, 80)})` : ''}` };
    }).filter(Boolean);
    const seen = new Set(GEMINI_VOICES.map((v) => v.id));
    libraryCache = { at: Date.now(), list: [...GEMINI_VOICES, ...more.filter((v) => !seen.has(v.id))] };
  } catch (e) {
    console.warn(`[voices] couldn't list Google's voice library (${e.message}): showing the studio voices`);
    libraryCache = { at: Date.now(), list: GEMINI_VOICES };
  }
  return libraryCache.list;
}

/** Every voice model and its price, side by side, in rupees: per 1,000 characters and per minute of speech. */
export function priceTable() {
  const CHARS_PER_SECOND = 20; // how fast Sakhi speaks with Sarvam's voice (measured, Nov 2026): to put per-character and per-second prices side by side
  const rows = [];
  for (const [model, m] of Object.entries(MODELS.sarvam)) {
    const per1000 = m.inrPer1000Chars();
    rows.push({ provider: 'sarvam', model, label: m.label, per1000Chars: per1000, perMinute: (per1000 / 1000) * CHARS_PER_SECOND * 60, billedBy: 'characters' });
  }
  for (const [model, m] of Object.entries(MODELS.gemini)) {
    const p = onDay(m.usd), outPerSecond = (p.output / 1e6) * AUDIO_TOKENS_PER_SECOND * usdInr();
    const inPer1000 = (p.input / 1e6) * (1000 / 4) * usdInr(); // about 4 characters a token
    rows.push({ provider: 'gemini', model, label: m.label, perMinute: outPerSecond * 60 + inPer1000 * (CHARS_PER_SECOND * 60 / 1000),
      per1000Chars: inPer1000 + outPerSecond * (1000 / CHARS_PER_SECOND), billedBy: 'seconds of sound (and a little for the text)', usd: p, ...(m.usd.later ? { rises: m.usd.later } : {}) });
  }
  return { rows, charsPerSecond: CHARS_PER_SECOND, usdInr: usdInr() };
}

// ---- splitting the text, the way it is sent ---------------------------------------------------------
/**
 * The pieces a text is sent as. mode:
 *   'one'        the whole text in one request (how one joined turn would sound)
 *   'app'        as the app sends Sakhi's turn today: her reaction and her question apart (marked with "|"
 *                in the text), and English and Hindi apart
 *   'sentences'  one request per sentence
 */
export function piecesOf(text, mode = 'one') {
  const clean = (t) => t.replace(/\s+/g, ' ').trim();
  if (mode === 'one') return [clean(text.replace(/\|/g, ' '))].filter(Boolean);
  const sentences = (t) => (t.match(/[^.!?।]+[.!?।]*\s*/g) || []).map(clean).filter(Boolean);
  if (mode === 'sentences') return text.split('|').flatMap(sentences);
  const out = [];
  for (const part of text.split('|')) {
    const groups = [];
    for (const s of sentences(part)) {
      const hindi = /[ऀ-ॿ]/.test(s), last = groups.at(-1);
      if (last && last.hindi === hindi) last.text += ` ${s}`; else groups.push({ text: s, hindi });
    }
    out.push(...groups.map((g) => g.text));
  }
  return out;
}
/** The language Sarvam is told for a piece: Hindi if it has any Devanagari, else English. */
export const sarvamLanguage = (text) => (/[ऀ-ॿ]/.test(text) ? 'hi-IN' : voiceLanguage(text));

// ---- making the sound --------------------------------------------------------------------------------
async function sarvamPiece(text, o) {
  const t0 = performance.now();
  const res = await fetch(`${config.sarvam.baseUrl}/text-to-speech/stream`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'api-subscription-key': config.sarvam.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      text, language_code: sarvamLanguage(text), speaker: o.voice, model: o.model, speech_sample_rate: SAMPLE_RATE, output_audio_codec: 'linear16',
      pace: o.pace ?? 1, ...(o.pitch != null ? { pitch: o.pitch } : {}), ...(o.loudness != null ? { loudness: o.loudness } : {}), ...(o.temperature != null ? { temperature: o.temperature } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Sarvam ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const parts = []; let firstByteMs = null;
  for await (const chunk of res.body) { firstByteMs ??= Math.round(performance.now() - t0); parts.push(Buffer.from(chunk)); }
  addVoice(text.length, { cached: false }); // counted towards the daily budget, like any voice
  return { pcm: Buffer.concat(parts), firstByteMs, ms: Math.round(performance.now() - t0), costInr: (MODELS.sarvam[o.model]?.inrPer1000Chars() ?? 2) * text.length / 1000 };
}

/** Reads Google's streamed answer (server-sent events): the sound, and what it counted. */
async function geminiPiece(text, o) {
  const t0 = performance.now();
  const res = await fetch(`${geminiBase()}/interactions`, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: o.model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, ...(o.style ? { annotations: [{ type: 'speech_metadata', style: o.style }] } : {}) }] }],
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: SAMPLE_RATE },
      generation_config: { speech_config: [{ voice: o.voice }] },
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const parts = []; let firstByteMs = null, usage = null, buffer = '';
  const take = (block) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return;
    let e; try { e = JSON.parse(data); } catch { return; }
    if (e.event_type === 'error' || e.error) throw new Error(`Google: ${String(e.error?.message || e.message || 'the voice failed').slice(0, 300)}`);
    const d = e.delta;
    if (e.event_type === 'step.delta' && d?.type === 'audio' && d.data) { firstByteMs ??= Math.round(performance.now() - t0); parts.push(Buffer.from(d.data, 'base64')); }
    const u = e.usage || e.interaction?.usage;
    if (u) usage = u;
  };
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) { const block = buffer.slice(0, at); buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, ''); take(block); }
  }
  if (buffer.trim()) take(buffer);
  const pcm = Buffer.concat(parts);
  if (!pcm.length) throw new Error('Google sent no sound');
  // What Google counted, if it says; otherwise an estimate (about 4 characters a token; 25 tokens a second of sound).
  const seconds = pcm.length / 2 / SAMPLE_RATE;
  const input = usage?.total_input_tokens ?? usage?.input_tokens ?? usage?.prompt_token_count ?? Math.ceil((text.length + (o.style || '').length) / 4);
  const output = usage?.total_output_tokens ?? usage?.output_tokens ?? usage?.candidates_token_count ?? Math.round(seconds * AUDIO_TOKENS_PER_SECOND);
  const p = onDay(MODELS.gemini[o.model]?.usd || MODELS.gemini['gemini-3.8-flash-tts'].usd);
  return { pcm, firstByteMs, ms: Math.round(performance.now() - t0), tokens: { input, output, counted: !!usage }, costInr: ((input * p.input + output * p.output) / 1e6) * usdInr() };
}

/**
 * Says a text with one voice. o: { provider, model, voice, text, mode, style?, pace?, pitch?, loudness?, temperature? }
 * → { pcm, pieces: [{ text, firstByteMs, ms, seconds, costInr }], firstAudioMs, totalMs, seconds, chars, costInr }
 * Pieces are made one after another and joined with a short gap, as the app plays separate lines.
 */
export async function say(o) {
  if (!configured[o.provider]?.()) throw Object.assign(new Error(o.provider === 'gemini' ? 'No Gemini key on the server (GEMINI_API_KEY): add it with deploy/llm-keys-setup.sh, PROVIDERS=gemini.' : 'No Sarvam key on the server.'), { status: 400 });
  const pieces = piecesOf(o.text, o.mode);
  if (!pieces.length) throw Object.assign(new Error('Type something to say.'), { status: 400 });
  const make = o.provider === 'gemini' ? geminiPiece : sarvamPiece;
  const t0 = performance.now(), out = [], gap = Buffer.alloc(Math.round(SAMPLE_RATE * 0.12) * 2);
  for (const text of pieces) {
    const p = await make(text, o);
    out.push({ text, ...p, seconds: +(p.pcm.length / 2 / SAMPLE_RATE).toFixed(2) });
  }
  const pcm = Buffer.concat(out.flatMap((p, i) => (i ? [gap, p.pcm] : [p.pcm])));
  return {
    pcm, firstAudioMs: out[0].firstByteMs, totalMs: Math.round(performance.now() - t0), seconds: +(pcm.length / 2 / SAMPLE_RATE).toFixed(2),
    chars: pieces.join('').length, costInr: out.reduce((n, p) => n + p.costInr, 0),
    pieces: out.map(({ pcm: _, ...p }) => p),
  };
}

/** 16-bit mono PCM → a WAV file. */
export function wav(pcm, rate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export const sarvamVoices = SARVAM_VOICES;
