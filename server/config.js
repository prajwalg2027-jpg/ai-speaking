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
    sttModel: env('SARVAM_STT_MODEL', 'saarika:v2.5'),
    sttTranslateModel: env('SARVAM_STT_TRANSLATE_MODEL', 'saaras:v2.5'),
    ttsModel: env('SARVAM_TTS_MODEL', 'bulbul:v2'),
    ttsSpeaker: env('SARVAM_TTS_SPEAKER', 'anushka'),
    llmModel: env('SARVAM_LLM_MODEL', 'sarvam-m'),
    timeouts: { stt: 10_000, tts: 8_000, llm: 15_000 },
  },
};

export const demoMode = () => !config.sarvam.apiKey;
