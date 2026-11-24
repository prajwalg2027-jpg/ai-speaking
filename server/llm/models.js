// The models each provider offers right now, for the admin console's model menus. Asked from the provider itself
// with the server's key (so new models appear without a code change), kept for ten minutes. A provider without a
// key, or whose list can't be fetched, falls back to a few known names. Any name can still be typed.
import Anthropic from '@anthropic-ai/sdk';
import { vertexOn, vertexToken, geminiConfigured } from './openai.js';

const KNOWN = {
  sarvam: ['sarvam-105b-conversations', 'sarvam-105b'], // Sarvam has no list to ask for: these are the chat models it accepts
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  openai: [],
  // Google's chat models (aistudio.google.com/docs/models, 23 Nov 2026). With a key, the list comes from Google.
  gemini: ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
};
// Not for conversation: speech, images, embeddings, moderation and older completion-only models.
const NOT_CHAT = /embed|tts|whisper|dall-e|image|imagen|audio|realtime|moderation|transcri|search|davinci|babbage|sora|veo|aqa|computer-use|codex|instruct|robotics|guard|learnlm|live|banana|omni|genie|lyria|decision|gemma/i;
const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, value: null };

async function getJson(url, key) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
const chatOnly = (ids) => [...new Set(ids.filter((id) => id && !NOT_CHAT.test(id)))].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));

const FETCH = {
  async openai() {
    const j = await getJson(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/models`, process.env.OPENAI_API_KEY);
    return chatOnly((j.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id)));
  },
  async gemini() {
    if (vertexOn()) {
      // Vertex AI's catalogue of Google's own models (Model Garden): publishers/google/models/<name>.
      const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
      const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
      const j = await getJson(`https://${host}/v1beta1/publishers/google/models?pageSize=500`, await vertexToken());
      return chatOnly((j.publisherModels || []).map((m) => String(m.name || '').split('/').pop().replace(/@.*$/, '')).filter((id) => /^gemini/.test(id)));
    }
    const j = await getJson(`${process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'}/models`, process.env.GEMINI_API_KEY);
    return chatOnly((j.data || []).map((m) => String(m.id || '').replace(/^models\//, '')).filter((id) => /^gemini/.test(id)));
  },
  async anthropic() {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, timeout: 8000, maxRetries: 0 });
    const ids = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    return chatOnly(ids);
  },
};
const READY = { openai: () => !!process.env.OPENAI_API_KEY, gemini: geminiConfigured, anthropic: () => !!process.env.ANTHROPIC_API_KEY };

/** → { sarvam: [...], anthropic: [...], openai: [...], gemini: [...] }: model names for the menus, newest first. */
export async function listModels({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = { ...KNOWN };
  await Promise.all(Object.keys(FETCH).map(async (p) => {
    if (!READY[p]()) return;
    try { const ids = await FETCH[p](); if (ids.length) value[p] = ids; }
    catch (e) { console.warn(`[llm] couldn't list ${p} models (${e.message}): showing the known names`); }
  }));
  cache = { at: Date.now(), value };
  return value;
}
