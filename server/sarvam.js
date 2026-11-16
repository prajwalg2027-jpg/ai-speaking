// Thin Sarvam AI client: STT (Saaras v4), TTS (Bulbul v4 Flash), chat (Sarvam-105B), text translate (Mayura).
// Realtime STT lives in live.js.
import { createHash } from 'node:crypto';
import { config } from './config.js';

const S = config.sarvam;

async function call(path, { body, json, timeout }, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${S.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'api-subscription-key': S.apiKey, ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : body,
      signal: ctrl.signal,
    });
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
      return call(path, { body, json, timeout }, 1);
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

function sttFields(mode) {
  const f = { model: S.sttModel, mode };
  if (S.sttLanguage) f.language_code = S.sttLanguage;
  return f;
}

/** Saaras v4, codemix mode: English stays Latin, Hindi stays Devanagari. */
export async function transcribe(wav) {
  const r = await call('/speech-to-text', { body: wavForm(wav, sttFields(S.sttMode)), timeout: S.timeouts.stt });
  return { transcript: r.transcript ?? '', languageCode: r.language_code ?? null };
}

/** Saaras v4, translate mode: English meaning of whatever was said (replaces legacy /speech-to-text-translate). */
export async function transcribeToEnglish(wav) {
  const r = await call('/speech-to-text', { body: wavForm(wav, sttFields('translate')), timeout: S.timeouts.stt });
  return { transcript: r.transcript ?? '', languageCode: r.language_code ?? null };
}

// Scripted prompts are synthesised once and cached by content hash.
const ttsCache = new Map();

/** Bulbul: returns base64 WAV. */
export async function speak(text, { lang = 'en-IN', pace = 1.0 } = {}) {
  const key = createHash('sha1').update([text, lang, pace, S.ttsSpeaker, S.ttsModel].join('|')).digest('hex');
  if (ttsCache.has(key)) return ttsCache.get(key);
  const p = call('/text-to-speech', {
    json: {
      text,
      language_code: lang,
      speaker: S.ttsSpeaker,
      model: S.ttsModel,
      pace,
      speech_sample_rate: S.ttsSampleRate,
      output_audio_codec: 'wav',
    },
    timeout: S.timeouts.tts,
  }).then((r) => r.audios?.[0]);
  ttsCache.set(key, p);
  p.catch(() => ttsCache.delete(key));
  return p;
}

/**
 * Chat completion (OpenAI-compatible). reasoning_effort and max_tokens are always set explicitly
 * because Sarvam has changed their defaults; reasoning tokens share the max_tokens budget.
 */
export async function chat(messages, { temperature = 0.2, maxTokens = 600, model = S.llmModel, json = false } = {}) {
  const r = await call('/v1/chat/completions', {
    json: {
      model, messages, temperature,
      max_tokens: maxTokens + 1024,
      reasoning_effort: S.llmReasoningEffort,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    },
    timeout: S.timeouts.llm,
  });
  // Reasoning may arrive in a separate field or inline as <think>…</think>; we only want the answer.
  const text = r.choices?.[0]?.message?.content ?? '';
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

/** Mayura: translate (code-mixed) text to English. Used for Hindi answers in live mode. */
export async function translateToEnglish(text) {
  const r = await call('/translate', {
    json: { input: text.slice(0, 1000), source_language_code: 'auto', target_language_code: 'en-IN', model: S.translateModel },
    timeout: S.timeouts.stt,
  });
  return r.translated_text ?? null;
}
