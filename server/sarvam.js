// Thin Sarvam AI client: STT (Saarika), STT-translate (Saaras), TTS (Bulbul), chat (Sarvam-M).
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

/** Saarika: transcript in the spoken language, plus detected language_code. */
export async function transcribe(wav, languageCode = 'unknown') {
  const r = await call('/speech-to-text', {
    body: wavForm(wav, { model: S.sttModel, language_code: languageCode }),
    timeout: S.timeouts.stt,
  });
  return { transcript: r.transcript ?? '', languageCode: r.language_code ?? null };
}

/** Saaras: English translation of whatever was said (used for Hindi answers). */
export async function transcribeToEnglish(wav) {
  const r = await call('/speech-to-text-translate', {
    body: wavForm(wav, { model: S.sttTranslateModel }),
    timeout: S.timeouts.stt,
  });
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
      target_language_code: lang,
      speaker: S.ttsSpeaker,
      model: S.ttsModel,
      pace,
      speech_sample_rate: 22050,
      enable_preprocessing: true,
    },
    timeout: S.timeouts.tts,
  }).then((r) => r.audios?.[0]);
  ttsCache.set(key, p);
  p.catch(() => ttsCache.delete(key));
  return p;
}

/** Sarvam-M chat completion (OpenAI-compatible). Strips any <think> block. */
export async function chat(messages, { temperature = 0.2, maxTokens = 600 } = {}) {
  const r = await call('/v1/chat/completions', {
    json: { model: S.llmModel, messages, temperature, max_tokens: maxTokens },
    timeout: S.timeouts.llm,
  });
  const text = r.choices?.[0]?.message?.content ?? '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Chat expecting JSON; retries once on parse failure, returns null if still bad. */
export async function chatJSON(messages, opts) {
  for (let i = 0; i < 2; i++) {
    const raw = await chat(i ? [...messages, { role: 'user', content: 'Reply with ONLY the JSON object.' }] : messages, opts);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* retry */ }
    }
  }
  return null;
}
