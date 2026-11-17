// Central config. Every Sarvam model is an env var so upgrades are config-only.
import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader (no dependency).
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = (k, d) => process.env[k] || d;

export const config = {
  port: Number(env('PORT', 3000)),
  sarvam: {
    apiKey: env('SARVAM_API_KEY', ''),
    baseUrl: env('SARVAM_BASE_URL', 'https://api.sarvam.ai'),
    // 'codemix' keeps English words in Latin script and Hindi words in Devanagari: exactly the signal
    // the placement test needs. Used by Realtime STT, and by the mic test page's REST transcription.
    sttModel: env('SARVAM_STT_MODEL', 'saaras:v4'),
    sttMode: env('SARVAM_STT_MODE', 'codemix'),
    sttLanguage: env('SARVAM_STT_LANGUAGE', ''), // empty = let the API auto-detect
    ttsModel: env('SARVAM_TTS_MODEL', 'bulbul:v4-flash'),
    // v4-flash voice IDs are <persona>_<lang>_<use case>; v2/v3 short names (e.g. "anushka") return 400.
    ttsSpeaker: env('SARVAM_TTS_SPEAKER', 'ishita_enhi_companion'),
    ttsSampleRate: Number(env('SARVAM_TTS_SAMPLE_RATE', 24000)),
    // Verified against the live API (Nov 2026): /v1/chat/completions accepts sarvam-105b and
    // sarvam-105b-conversations; sarvam-m and sarvam-30b return 400, as does reasoning_effort "none".
    llmModel: env('SARVAM_LLM_MODEL', 'sarvam-105b'),
    llmReplyModel: env('SARVAM_LLM_REPLY_MODEL', 'sarvam-105b-conversations'),
    // Reasoning tokens count against max_tokens. "low" is the lowest value every model accepts.
    llmReasoningEffort: env('SARVAM_LLM_REASONING_EFFORT', 'low'),
    // Realtime STT (WebSocket, server-side VAD): the app's only speech-to-text path.
    realtime: {
      url: env('SARVAM_REALTIME_URL', 'wss://api.sarvam.ai/speech-to-text-realtime/ws'),
      model: env('SARVAM_REALTIME_MODEL', 'saaras:v4'),
      streamType: env('SARVAM_REALTIME_STREAM_TYPE', 'balanced'), // fast | balanced
    },
    timeouts: { stt: 20_000, tts: 8_000, llm: 15_000 },
  },
};

/** The app needs a Sarvam key; without one it reports why instead of running a fallback. */
export const ready = () => !!config.sarvam.apiKey;
