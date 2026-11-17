// HTTP server: static files, /api proxy to Sarvam, and the /api/live realtime STT relay.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ready } from './config.js';
import * as sarvam from './sarvam.js';
import { attachLiveRelay } from './live.js';
import { detectClarification, isUnintelligible, looksTruncated } from './clarify.js';
import { features, heuristicScores, blend, provisionalLevel, finalLevel, readAccuracy } from './scoring.js';
import { normalizeForCompare } from './normalize.js';
import { JUDGE_SYSTEM, judgeUser, INTENT_SYSTEM, REPLY_SYSTEM } from './prompts.js';
import { QUESTIONS, variantFor } from '../shared/assessment.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Per-request trace returned to the browser so its log panel can show what the server did. */
function makeTrace() {
  const t0 = performance.now();
  const list = [];
  const add = (step, detail = {}) => list.push({ step, at: Math.round(performance.now() - t0), ...detail });
  /** Run fn, recording its duration and a summary of the result (or the error). */
  const time = async (step, fn, summarize = () => ({})) => {
    const s = performance.now();
    try {
      const r = await fn();
      list.push({ step, at: Math.round(s - t0), ms: Math.round(performance.now() - s), ...summarize(r) });
      return r;
    } catch (e) {
      list.push({ step, at: Math.round(s - t0), ms: Math.round(performance.now() - s), error: e.message });
      throw e;
    }
  };
  return { list, add, time, total: () => Math.round(performance.now() - t0) };
}

const readBody = async (req, limit = 8 * 1024 * 1024) => {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('Payload too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
};
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

/**
 * Evaluate one answer. Transport-independent: called with a transcript that came from
 * Realtime STT (already transcribed in the browser session); Sarvam-105B reads Hindi directly, so there's no translation step.
 */
export async function evaluateTurn({ qIndex, level, transcript, languageCode = null, speechSec = 0, prior = '' }, trace = makeTrace()) {
  const question = QUESTIONS[qIndex];
  if (!question) throw Object.assign(new Error('bad question index'), { status: 400 });
  const variant = variantFor(question, level);
  transcript = [prior, transcript].filter(Boolean).join(' ').trim();
  const done = (out) => ({ ...out, trace: trace.list, serverMs: trace.total() });
  trace.add('question', { id: question.id, kind: question.kind, level, transcript, speechSec, ...(prior ? { joinedWithPrevious: prior } : {}) });

  // 1. Did we fail to understand the user?
  if (isUnintelligible(transcript)) {
    trace.add('check', { result: "didn't hear", why: 'transcript is empty or under 2 letters' });
    return done({ action: 'didnt_hear', transcript });
  }
  if (looksTruncated(transcript, speechSec)) {
    trace.add('check', { result: 'cut off', why: 'short answer ending on a connecting word' });
    return done({ action: 'cut_off', transcript });
  }

  // 2. Is the user asking us to clarify?
  let intent = detectClarification(transcript);
  if (intent) trace.add('clarify', { intent, by: 'keyword match' });
  else if (transcript.split(/\s+/).length <= 4 && question.kind !== 'vocab') {
    // Ambiguous short reply: ask the LLM (skip for vocab, where 1-2 word answers are normal).
    const meta = {};
    intent = (await trace.time('intent', () => sarvam.chatJSON([{ role: 'system', content: INTENT_SYSTEM },
      { role: 'user', content: `Tutor asked: ${variant.say}\nLearner replied: ${transcript}` }], { temperature: 0, maxTokens: 30, meta }),
    (r) => ({ model: meta.model, result: r, usage: meta.usage })).catch(() => null))?.intent;
    if (intent === 'answer' || intent === 'off_topic') intent = null;
  } else {
    trace.add('clarify', { intent: null, by: 'keyword match', note: 'treated as an answer' });
  }
  if (intent) return done({ action: 'clarify', intent, transcript });

  // 3. Score it (LLM judge + acknowledgment in parallel).
  const f = features(transcript, { speechSec, kind: question.kind, reference: variant.screen, expect: variant.expect });
  const heur = heuristicScores(f, question.kind);
  trace.add('features', f);
  trace.add('heuristic', heur);
  const jm = {}, am = {};
  const [llm, ack] = await Promise.all([
    trace.time('judge', () => sarvam.chatJSON([{ role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: judgeUser({ question: variant.say, transcript, features: f, kind: question.kind, reference: question.kind === 'read' ? variant.screen : null }) }], { meta: jm }),
    (r) => ({ model: jm.model, scores: r, finish: jm.finish, usage: jm.usage })).catch(() => null),
    question.id === 'q1_intro'
      ? trace.time('reply', () => sarvam.chat([{ role: 'system', content: REPLY_SYSTEM }, { role: 'user', content: transcript }],
        { temperature: 0.6, maxTokens: 60, model: config.sarvam.llmReplyModel, meta: am }),
      (r) => ({ model: am.model, text: r, usage: am.usage })).catch(() => null)
      : null,
  ]);
  const scores = blend(llm, heur);
  trace.add('scores', { blend: llm ? '60% LLM + 40% features' : 'features only', ...Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, +v.toFixed(2)])) });
  const out = { action: 'scored', transcript, languageCode, features: f, scores, llmNote: llm?.note ?? null, ack };
  if (question.id === 'q1_intro') {
    out.provisionalLevel = provisionalLevel(f, scores);
    trace.add('level', { provisionalLevel: out.provisionalLevel, note: 'picks the versions of Q2–Q4' });
  }
  return done(out);
}

// ---- /api/turn ------------------------------------------------------------
// Query: q (question index), level (variant level), speechSec, prior (text to prepend after a cut-off).
// Body: JSON {transcript, languageCode} from Realtime STT.
async function handleTurn(req, res, url) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'expected a JSON transcript' });
  const trace = makeTrace();
  const j = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
  const args = {
    qIndex: Number(url.searchParams.get('q')),
    level: Number(url.searchParams.get('level') || 2),
    speechSec: Number(url.searchParams.get('speechSec') || 0),
    prior: url.searchParams.get('prior') || '',
    transcript: String(j.transcript || ''),
    languageCode: j.languageCode || null,
  };
  trace.add('input', { via: 'transcript from Realtime STT', languageCode: args.languageCode });
  send(res, 200, await evaluateTurn(args, trace));
}

async function handleTTS(req, res) {
  const { text, lang = 'en-IN', pace = 1 } = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  if (!text || text.length > 2500) return send(res, 400, { error: 'text required (max 2500 chars)' });
  const cached = sarvam.isSpeechCached(text, { lang, pace });
  const s = performance.now();
  const audio = await sarvam.speak(text, { lang, pace });
  const S = config.sarvam;
  send(res, 200, { audio, trace: { model: S.ttsModel, speaker: S.ttsSpeaker, lang, pace, chars: text.length, cached, ms: Math.round(performance.now() - s), kb: audio ? Math.round((audio.length * 3) / 4 / 1024) : 0 } });
}

// ---- STT lab: /api/lab/transcribe and /api/lab/compare ------------------------
// Every option of Sarvam's REST speech-to-text (sarvamai SDK 1.1.19). Blank = Sarvam's default.
const REST_LANGS = ['unknown', 'en-IN', 'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN', 'gu-IN',
  'as-IN', 'ur-IN', 'ne-IN', 'kok-IN', 'ks-IN', 'sd-IN', 'sa-IN', 'sat-IN', 'mni-IN', 'brx-IN', 'mai-IN', 'doi-IN'];
const REST_OPTIONS = {
  model: (v) => (['saaras:v4', 'saaras:v3'].includes(v) ? v : null),
  mode: (v) => (['transcribe', 'translate', 'verbatim', 'translit', 'codemix'].includes(v) ? v : null),
  language_code: (v) => (REST_LANGS.includes(v) ? v : null),
  with_timestamps: (v) => (['true', 'false'].includes(v) ? v : null),
  keyterms: (v) => { // JSON array of up to 50 terms, 64 characters each (saaras:v4 only)
    try { const a = JSON.parse(v); return Array.isArray(a) && a.length <= 50 && a.every((t) => typeof t === 'string' && t.length <= 64) ? JSON.stringify(a) : null; } catch { return null; }
  },
};

// Body: 16 kHz WAV (max 30 s, Sarvam's REST limit). Query: expect (the sentence the tester read) + REST options.
async function handleLabTranscribe(req, res, url) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  const expect = url.searchParams.get('expect') || '';
  const options = {}, rejected = [];
  for (const [k, check] of Object.entries(REST_OPTIONS)) {
    const v = url.searchParams.get(k);
    if (v == null || v === '') continue;
    const ok = check(v);
    if (ok == null) rejected.push(k); else options[k] = ok;
  }
  if (rejected.length) return send(res, 400, { error: `invalid values for: ${rejected.join(', ')}` });
  const wav = await readBody(req, 2 * 1024 * 1024);
  const s = performance.now();
  let r;
  try { r = await sarvam.transcribe(wav, options); }
  catch (e) { return send(res, 502, { error: e.message, ms: Math.round(performance.now() - s) }); }
  send(res, 200, {
    ...r, ms: Math.round(performance.now() - s), model: options.model || config.sarvam.sttModel, mode: options.mode || config.sarvam.sttMode, options,
    audioSec: +((wav.length - 44) / 32000).toFixed(2),
    accuracy: expect ? +readAccuracy(expect, r.transcript).toFixed(3) : null,
    // What was actually compared, after normalising numbers, contractions and spelling.
    compared: expect ? { expected: normalizeForCompare(expect).join(' '), heard: normalizeForCompare(r.transcript).join(' ') } : null,
  });
}

// Body: JSON {expected, heard}. Scores a transcript (e.g. from a live run) the same way.
async function handleLabCompare(req, res) {
  const { expected = '', heard = '' } = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
  send(res, 200, { accuracy: expected ? +readAccuracy(expected, heard).toFixed(3) : null,
    compared: { expected: normalizeForCompare(expected).join(' '), heard: normalizeForCompare(heard).join(' ') } });
}

async function handleFinal(req, res) {
  const { answers } = JSON.parse((await readBody(req, 512 * 1024)).toString() || '{}');
  if (!Array.isArray(answers)) return send(res, 400, { error: 'answers[] required' });
  send(res, 200, finalLevel(answers));
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'public/index.html' : pathname.startsWith('/shared/') ? pathname.slice(1) : `public${pathname}`;
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, ready() ? { ready: true } : { ready: false, reason: 'SARVAM_API_KEY is not set on the server' });
    }
    if (req.method === 'POST' && url.pathname === '/api/turn') return await handleTurn(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/tts') return await handleTTS(req, res);
    if (req.method === 'POST' && url.pathname === '/api/final') return await handleFinal(req, res);
    if (req.method === 'POST' && url.pathname === '/api/lab/transcribe') return await handleLabTranscribe(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/lab/compare') return await handleLabCompare(req, res);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status || 502, { error: e.name === 'AbortError' ? 'Upstream timeout' : e.message });
  }
});

attachLiveRelay(server, { enabled: ready });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, () => console.log(`AI English Coach on http://localhost:${config.port}${ready() ? '' : '  (not ready: SARVAM_API_KEY is not set)'}`));
}
