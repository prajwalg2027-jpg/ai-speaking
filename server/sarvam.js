// Thin Sarvam AI client: TTS (Bulbul v4 Flash), chat (Sarvam-105B), and REST STT for the mic test page.
// Realtime STT lives in live.js.
import { createHash } from 'node:crypto';
import { addVoice, addChat } from './costs.js';
import { config } from './config.js';
import * as voiceStore from './voicecache.js';
import * as settings from './settings.js';
import { speakPiece, configured as voiceConfigured } from './voices/index.js';

const S = config.sarvam;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sarvam is busy (429) or briefly down (5xx): how long to wait before trying again (honours Retry-After, max 5 s). */
export function retryWait(res, attempt) {
  const after = Number(res.headers?.get?.('retry-after'));
  const base = Number.isFinite(after) && after > 0 ? after * 1000 : 400 * 2 ** attempt;
  return Math.min(5_000, base) + Math.random() * 300;
}
const retryable = (status) => status === 429 || status >= 500;

async function call(path, { body, json, timeout, retries = 2 }, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${S.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'api-subscription-key': S.apiKey, ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : body,
      signal: ctrl.signal,
    });
    if (retryable(res.status) && attempt < retries) {
      await sleep(retryWait(res, attempt));
      return call(path, { body, json, timeout, retries }, attempt + 1);
    }
    if (!res.ok) throw new Error(`Sarvam ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

const wavForm = (wav, fields) => {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'answer.wav');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

function sttFields(mode, overrides = {}) {
  const f = { model: S.sttModel, mode };
  if (S.sttLanguage) f.language_code = S.sttLanguage;
  return { ...f, ...overrides };
}

/** Saaras v4 REST, codemix mode (mic test page only; the app uses Realtime STT). Max 30 s of audio. */
export async function transcribe(wav, overrides = {}) {
  const r = await call('/speech-to-text', { body: wavForm(wav, sttFields(S.sttMode, overrides)), timeout: S.timeouts.stt });
  return { transcript: r.transcript ?? '', languageCode: r.language_code ?? null, languageProbability: r.language_probability ?? null, requestId: r.request_id ?? null, timestamps: r.timestamps ?? null };
}


// ---- Text-to-speech: Bulbul v4 Flash, streamed --------------------------------
// /text-to-speech/stream returns raw 16-bit PCM as it's generated (first audio in about 0.5 s, versus
// about 2 s for the whole clip from /text-to-speech). Finished clips are cached by content, so scripted
// lines, generated when the server starts, play instantly.
export const TTS_RATE = 24000;
const pcmCache = new Map();  // key → Buffer (complete PCM), oldest first
const pinned = new Set();    // keys of fixed lines (generated at start): never dropped
let cachedBytes = 0;
const CACHE_BYTES = Number(process.env.SAKHI_VOICE_CACHE_MB || 150) * 1024 * 1024;
/** Keep a finished clip. Generated lines are dropped oldest-first past CACHE_BYTES, so memory stays bounded. */
function remember(key, buf, pin) {
  if (pcmCache.has(key)) cachedBytes -= pcmCache.get(key).length;
  pcmCache.delete(key); pcmCache.set(key, buf); cachedBytes += buf.length;
  if (pin) pinned.add(key);
  for (const [k, b] of pcmCache) {
    if (cachedBytes <= CACHE_BYTES) break;
    if (pinned.has(k)) continue;
    pcmCache.delete(k); cachedBytes -= b.length;
  }
}
const pending = new Map();   // key → { job: Promise of a generation in progress, parts: the audio so far, listeners }

// Fixed lines saved to the voice store (server/voicecache.js) this run, so each is written once.
const kept = new Set();
function keep(key, pcm) {
  if (kept.has(key) || !voiceStore.voiceCacheEnabled()) return;
  kept.add(key);
  voiceStore.save(key, pcm).catch((e) => { kept.delete(key); console.warn('[voice] not kept for the next start:', e.message); });
}

/**
 * The voice Sakhi speaks with now: the admin's choice (settings section "voice"), or Sarvam's Bulbul when that is
 * chosen or when the chosen Google route isn't set up on this server (no Google sign-in locally, no Gemini key).
 * → { source, model, voice, style?, fallback }
 */
export function voiceInUse() {
  const v = settings.get('voice');
  if (v && v.source !== 'sarvam' && voiceConfigured[v.source]?.()) return { source: v.source, model: v.model, voice: v.voice, style: v.style || '', fallback: v.fallbackToSarvam };
  return { source: 'sarvam', model: S.ttsModel, voice: S.ttsSpeaker, fallback: false };
}
// A clip's key: the words and the voice that said them. Sarvam's keys are as they always were, so its stored lines stay good.
const ttsKey = (text, lang, pace, v = voiceInUse()) => createHash('sha1').update(
  (v.source === 'sarvam' ? [text, lang, pace, S.ttsSpeaker, S.ttsModel, TTS_RATE] : [text, lang, pace, v.source, v.model, v.voice, v.style, TTS_RATE]).join('|'),
).digest('hex');

/**
 * Speak `text`, calling onChunk(Buffer) as audio arrives. Resolves { cached, bytes, firstByteMs }.
 * Identical requests share one generation.
 */
export async function streamSpeech(text, { lang = 'en-IN', pace = 1.0, pin = false } = {}, onChunk = () => {}) {
  const voice = voiceInUse();
  const key = ttsKey(text, lang, pace, voice);
  // A cached line (or one another request is already generating) costs this conversation nothing.
  if (pcmCache.has(key)) {
    const b = pcmCache.get(key); remember(key, b, pin);
    if (pin) keep(key, b); // a fixed line first heard in a conversation: keep it for the next start too
    addVoice(text.length, { cached: true }); onChunk(b); return { cached: true, bytes: b.length, firstByteMs: 0 };
  }
  // A fixed line kept from an earlier start: no Sarvam call.
  if (pin && voiceStore.voiceCacheEnabled()) {
    const b = await voiceStore.load(key);
    if (b?.length) { remember(key, b, pin); kept.add(key); addVoice(text.length, { cached: true }); onChunk(b); return { cached: true, bytes: b.length, firstByteMs: 0, stored: true }; }
  }
  // Someone is already generating this line (her reaction, started before the turn was finished): join it. The
  // audio so far is handed over at once and the rest as it comes, so starting early never makes anyone wait.
  if (pending.has(key)) {
    const p = pending.get(key);
    let got = 0;
    const hear = (b) => { got += b.length; onChunk(b); };
    for (const b of p.parts) hear(b);
    p.listeners.add(hear);
    try { const all = await p.job; addVoice(text.length, { cached: true }); return { cached: true, joined: true, bytes: all.length, firstByteMs: 0 }; }
    catch (e) { if (got) throw e; /* nothing heard yet: generate it ourselves, below */ }
    finally { p.listeners.delete(hear); }
    if (pcmCache.has(key)) return streamSpeech(text, { lang, pace, pin }, onChunk);
  }

  const t0 = performance.now();
  let firstByteMs = null;
  const entry = { job: null, parts: [], listeners: new Set() };
  const send = (b) => {
    firstByteMs ??= Math.round(performance.now() - t0);
    entry.parts.push(b);
    onChunk(b);
    for (const hear of entry.listeners) { try { hear(b); } catch { /* that listener went away */ } }
  };
  const finish = (all) => { if (all.length) { remember(key, all, pin); if (pin) keep(key, all); } return all; };
  const job = (async () => {
    if (voice.source !== 'sarvam') {
      // A Google Gemini voice, streamed. If it fails before any sound was sent, Sarvam says the line instead (not
      // kept, so the Google voice is tried again next time); after some sound, the line can't be patched: fail.
      try {
        // Google is told the pace in words: a number for the speed isn't something every Gemini voice takes.
        const style = [voice.style, pace < 1 ? 'Speak a little slower than usual, clearly.' : ''].filter(Boolean).join(' ');
        const r = await speakPiece(voice.source, text, { model: voice.model, voice: voice.voice, style, timeoutMs: 20_000 }, send);
        addVoice(text.length, { cached: false, inr: r.costInr });
        return finish(r.pcm);
      } catch (e) {
        if (entry.parts.length || !voice.fallback) throw e;
        console.warn(`[voice] ${voice.source} ${voice.model} failed, Sarvam says this line instead: ${e.message}`);
        return sarvamSpeech(text, lang, pace, send);
      }
    }
    return finish(await sarvamSpeech(text, lang, pace, send));
  })();
  entry.job = job;
  job.catch(() => {}); // listeners that joined handle a failure themselves
  pending.set(key, entry);
  try { const all = await job; return { cached: false, bytes: all.length, firstByteMs }; }
  finally { pending.delete(key); }
}

/** One line in Sarvam's Bulbul voice, streamed to send(Buffer). → the whole clip. */
async function sarvamSpeech(text, lang, pace, send) {
  const parts = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    // Busy or briefly down: try again (up to twice) before any audio has been sent, so the learner only
    // notices a short pause.
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${S.baseUrl}/text-to-speech/stream`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'api-subscription-key': S.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text, language_code: lang, speaker: S.ttsSpeaker, model: S.ttsModel, pace, speech_sample_rate: TTS_RATE, output_audio_codec: 'linear16' }),
      });
      if (!retryable(res.status) || attempt >= 2) break;
      await res.body?.cancel().catch(() => {});
      await sleep(retryWait(res, attempt));
    }
    if (!res.ok) throw new Error(`Sarvam /text-to-speech/stream ${res.status}: ${(await res.text()).slice(0, 300)}`);
    addVoice(text.length, { cached: false }); // billed per character sent
    for await (const chunk of res.body) { const b = Buffer.from(chunk); parts.push(b); send(b); }
    return Buffer.concat(parts);
  } finally { clearTimeout(timer); }
}

export const isSpeechCached = (text, { lang = 'en-IN', pace = 1.0 } = {}) => pcmCache.has(ttsKey(text, lang, pace));

/** How long a generated line lasts, in seconds (null if it isn't in the cache). */
export function speechSeconds(text, { lang = 'en-IN', pace = 1.0 } = {}) {
  const b = pcmCache.get(ttsKey(text, lang, pace));
  return b ? b.length / 2 / TTS_RATE : null;
}

/**
 * Generate the fixed lines ahead of time, one at a time, so a server start doesn't burst into Sarvam's rate
 * limit while learners are being served. If Sarvam is busy, wait and carry on; lines still missing are
 * generated the first time a learner needs them.
 */
export async function pregenerate(lines, { gapMs = 100, busyWaitMs = 15_000, parallel = 16 } = {}) {
  let done = 0, failed = 0, busyInARow = 0, stored = 0;
  // First, load everything the voice store already has, many at a time (a restart is ready in seconds).
  const waiting = [];
  if (voiceStore.voiceCacheEnabled()) {
    const queue = [...lines];
    await Promise.all(Array.from({ length: parallel }, async () => {
      for (let l; (l = queue.shift());) {
        const key = ttsKey(l.text, l.lang || 'en-IN', l.pace ?? 1.0);
        const b = pcmCache.has(key) ? pcmCache.get(key) : await voiceStore.load(key);
        if (b?.length) { remember(key, b, true); kept.add(key); stored++; done++; } else waiting.push(l);
      }
    }));
  } else waiting.push(...lines);
  // Then generate what's missing, one at a time, so a start doesn't burst into Sarvam's rate limit.
  for (const l of waiting) {
    try {
      const r = await streamSpeech(l.text, { ...l, pin: true }); done++; busyInARow = 0;
      if (r.stored) { stored++; continue; } // loaded from the store: no Sarvam call, no need to pace
    }
    catch (e) {
      failed++;
      if (/ 429|RESOURCE_EXHAUSTED|quota/i.test(e.message)) { if (++busyInARow >= 3) break; await sleep(busyWaitMs); }
    }
    await sleep(gapMs);
  }
  return { done, failed, stored };
}

/**
 * Chat completion (OpenAI-compatible). reasoning_effort and max_tokens are always set explicitly
 * because Sarvam has changed their defaults; reasoning tokens share the max_tokens budget.
 */
export async function chat(messages, { temperature = 0.2, maxTokens = 600, model = S.llmModel, json = false, meta = null, purpose = 'other' } = {}) {
  const r = await call('/v1/chat/completions', {
    json: {
      model, messages, temperature,
      max_tokens: maxTokens + 1024,
      reasoning_effort: S.llmReasoningEffort,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    },
    timeout: S.timeouts.llm,
    retries: 4, // rate limits (429) are common under load: up to ~15 s of waiting before giving up
  });
  addChat(r.usage, purpose);
  // Reasoning may arrive in a separate field or inline as <think>…</think>; we only want the answer.
  const text = r.choices?.[0]?.message?.content ?? '';
  const thinking = [r.choices?.[0]?.message?.reasoning_content, ...[...text.matchAll(/<think>([\s\S]*?)<\/think>/g)].map((m) => m[1])].filter(Boolean).join('\n').trim();
  if (meta) Object.assign(meta, { model, finish: r.choices?.[0]?.finish_reason ?? null, usage: r.usage ?? null, raw: text.slice(0, 600), thinking: thinking || null });
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Chat expecting JSON (JSON mode); retries once on parse failure, returns null if still bad. */
export async function chatJSON(messages, opts) {
  for (let i = 0; i < 2; i++) {
    const raw = await chat(i ? [...messages, { role: 'user', content: 'Reply with ONLY the JSON object.' }] : messages, { ...opts, json: true });
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* retry */ }
    }
  }
  return null;
}

