// Comparing voices for Sakhi (admin console › Compare voices): Sarvam's and Google's, side by side, on the same
// words, with how long each took to start and to finish, and what it cost. Nothing is saved; the app's own
// voice is not changed here.
//
//   GET  /api/admin/voices         → { providers, models, voices, prices, samples, modes }
//   POST /api/admin/voices/speak   { provider: sarvam|cloudtts|gemini, model, voice, text, mode, style?, pace?, pitch?, loudness?, temperature? }
//                                  → { audio: WAV in base64, sampleRate, firstAudioMs, totalMs, seconds, chars, costInr, pieces }
import { z } from 'zod';
import { readJson, send, fail } from '../http.js';
import * as voices from '../voices/index.js';
import { config } from '../config.js';

// Sakhi's real lines, to hear each voice on what it would really say. "|" marks where her reaction ends and her
// question begins (the app sends the two apart today).
const SAMPLES = [
  { label: 'Reaction, then the picture question', text: "Nice to meet you, Prajwal! | There's a picture on your screen. What is it called in English?" },
  { label: 'The hello, in English and Hindi', text: 'Hi, my name is Sakhi. What is your name? नमस्ते, मेरा नाम सखी है। आपका नाम क्या है?' },
  { label: 'A gentle fix, then an open question', text: 'Oh, you went to the market yesterday! | What did you buy there?' },
  { label: 'Help in Hindi, for a beginner', text: 'No problem, take your time. | Look at the picture. आप इसे अंग्रेज़ी में क्या कहेंगे?' },
  { label: 'The reading request', text: 'Thank you, that was clear. | Now there is a line of English on your screen. Could you read it out loud for me?' },
  { label: 'The goodbye, with the level', text: 'That sounds lovely. | Thank you! Your English is at level 3 of 4, Good. You talked about your day in clear sentences. Next, we will practise talking about the past.' },
];
const MODES = [
  ['app', 'As Sakhi is sent today: reaction and question apart, English and Hindi apart'],
  ['one', 'As one request (the whole text together)'],
  ['sentences', 'One request per sentence'],
];

const Speak = z.strictObject({
  provider: z.enum(['sarvam', 'cloudtts', 'gemini']),
  model: z.string().trim().min(1).max(80),
  voice: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(1200),
  mode: z.enum(['app', 'one', 'sentences']).default('one'),
  style: z.string().trim().max(400).optional(), // Google only: how to say it ("warm and friendly"); Cloud Text-to-Speech calls it the prompt
  pace: z.number().min(0.5).max(2).optional(), // Sarvam, and Google Cloud's speaking rate
  pitch: z.number().min(-0.5).max(0.5).optional(),
  loudness: z.number().min(0.1).max(2.5).optional(),
  temperature: z.number().min(0.01).max(1).optional(),
});

export async function handleVoices(req, res, url) {
  const p = url.pathname, m = req.method;
  if (m === 'GET' && p === '/api/admin/voices') {
    return send(res, 200, {
      providers: Object.fromEntries(Object.keys(voices.MODELS).map((k) => [k, { configured: voices.configured[k]() }])),
      models: Object.fromEntries(Object.entries(voices.MODELS).map(([prov, ms]) => [prov, Object.entries(ms).map(([id, x]) => ({ id, label: x.label }))])),
      voices: {
        sarvam: { 'bulbul:v4-flash': voices.sarvamVoices['bulbul:v4-flash'], 'bulbul:v3': voices.sarvamVoices['bulbul:v3'], asOf: voices.sarvamVoices.asOf },
        gemini: await voices.geminiVoices(),
        cloudtts: voices.GEMINI_VOICES, // the same 30 voices, by name
      },
      current: { provider: 'sarvam', model: config.sarvam.ttsModel, voice: config.sarvam.ttsSpeaker }, // what the app speaks with now
      prices: voices.priceTable(), samples: SAMPLES, modes: MODES,
    }), true;
  }
  if (m === 'POST' && p === '/api/admin/voices/speak') {
    const r = Speak.safeParse(await readJson(req));
    if (!r.success) throw fail(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const o = r.data;
    if (!voices.MODELS[o.provider][o.model] && !/^(bulbul:|gemini-)/.test(o.model)) throw fail(400, `Unknown voice model "${o.model}".`);
    let out;
    try { out = await voices.say(o); }
    // The provider's own words are shown to the team (this page is the admin's only).
    catch (e) { throw e.status ? e : fail(502, e.message, { reason: e.message }); }
    const { pcm, ...rest } = out;
    return send(res, 200, { audio: voices.wav(pcm).toString('base64'), sampleRate: voices.SAMPLE_RATE, ...rest }), true;
  }
  throw fail(404, 'not found');
}
