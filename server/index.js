// HTTP server: static files, the conversation API, streamed voice, the STT lab, and the /api/live relay.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ready } from './config.js';
import * as sarvam from './sarvam.js';
import { attachLiveRelay } from './live.js';
import { readAccuracy } from './scoring.js';
import { normalizeForCompare } from './normalize.js';
import { makeTrace } from './trace.js';
import { startSession, getSession, handleTurn, scriptedLines } from './session.js';
import { withLedger, summarize, shared, addSpeechToText } from './costs.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const readBody = async (req, limit = 8 * 1024 * 1024) => {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('Payload too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
};
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

// ---- Conversation --------------------------------------------------------------
// POST /api/session            → Sakhi's opening turn (and a sessionId)
// POST /api/session/turn       → body {sessionId, event, transcript?, languageCode?, speechSec?, interrupted?: {index, heardSec}} → Sakhi's next turn
// Each turn: { say: [{text, lang, pace}], card, listen: {silenceMs, language} | null, done?, heard?, trace, serverMs, cost }
// GET  /api/session/cost?id=…  → what the conversation has cost so far in Sarvam charges (server/costs.js)
// Sarvam calls made while handling a conversation are charged to its ledger.
const json = async (req, limit = 64 * 1024) => JSON.parse((await readBody(req, limit)).toString() || '{}');

async function handleSessionStart(req, res) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  const trace = makeTrace();
  const turn = startSession();
  send(res, 200, { ...turn, trace: trace.list, serverMs: trace.total(), cost: summarize(getSession(turn.sessionId).ledger) });
}

async function handleSessionTurn(req, res) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  const body = await json(req);
  const s = getSession(body.sessionId);
  if (!s) return send(res, 404, { error: 'session not found (it may have expired); start again' });
  const trace = makeTrace();
  trace.add('input', { event: body.event, via: 'transcript from Realtime STT', languageCode: body.languageCode ?? null });
  const turn = await withLedger(s.ledger, () => handleTurn(s, {
    event: body.event, transcript: String(body.transcript || ''), languageCode: body.languageCode || null, speechSec: Number(body.speechSec) || 0,
    // Set when the learner talked over Sakhi: which of her lines, and how many seconds of it they heard.
    interrupted: body.interrupted ? { index: Number(body.interrupted.index) || 0, heardSec: Number(body.interrupted.heardSec) || 0 } : null,
    // Measured from the mic while they spoke (fluency): see features() in scoring.js.
    timing: body.timing && Number.isFinite(Number(body.timing.spanSec)) ? {
      spanSec: Number(body.timing.spanSec), voicedSec: Number(body.timing.voicedSec) || 0,
      pauses: (Array.isArray(body.timing.pauses) ? body.timing.pauses : []).slice(0, 200).map(Number).filter(Number.isFinite),
    } : null,
  }, trace));
  send(res, 200, { ...turn, trace: trace.list, serverMs: trace.total(), cost: summarize(s.ledger) });
}

// POST /api/tts/stream {text, lang, pace, sessionId?} → raw 16-bit PCM, mono, streamed as Bulbul generates it.
// With a sessionId, a generated line is charged to that conversation.
async function handleTTSStream(req, res) {
  const { text, lang = 'en-IN', pace = 1, sessionId } = await json(req);
  const s = sessionId ? getSession(sessionId) : null;
  return withLedger(s?.ledger || shared, () => speakTo(res, { text, lang, pace }));
}

async function speakTo(res, { text, lang, pace }) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  if (!text || text.length > 2500) return send(res, 400, { error: 'text required (max 2500 chars)' });
  const cached = sarvam.isSpeechCached(text, { lang, pace });
  let started = false;
  const start = () => {
    if (started) return; started = true;
    res.writeHead(200, { 'content-type': 'audio/pcm', 'x-sample-rate': String(sarvam.TTS_RATE), 'x-tts-cached': String(cached), 'x-tts-model': config.sarvam.ttsModel, 'x-tts-speaker': config.sarvam.ttsSpeaker, 'cache-control': 'no-store' });
  };
  try {
    await sarvam.streamSpeech(text, { lang, pace }, (chunk) => { start(); res.write(chunk); });
    start(); res.end();
  } catch (e) {
    if (!started) return send(res, 502, { error: e.message });
    res.destroy(e); // headers already sent: cut the stream so the browser sees the failure
  }
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
    if (req.method === 'POST' && url.pathname === '/api/session') return await handleSessionStart(req, res);
    if (req.method === 'POST' && url.pathname === '/api/session/turn') return await handleSessionTurn(req, res);
    if (req.method === 'GET' && url.pathname === '/api/session/cost') {
      const s = getSession(url.searchParams.get('id'));
      return s ? send(res, 200, summarize(s.ledger)) : send(res, 404, { error: 'session not found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/tts/stream') return await handleTTSStream(req, res);
    if (req.method === 'POST' && url.pathname === '/api/lab/transcribe') return await handleLabTranscribe(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/lab/compare') return await handleLabCompare(req, res);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status || 502, { error: e.name === 'AbortError' ? 'Upstream timeout' : e.message });
  }
});

// Audio the relay sends to Sarvam is charged to the conversation the browser says it belongs to.
attachLiveRelay(server, { enabled: ready, onAudio: (sessionId, seconds) => addSpeechToText(getSession(sessionId)?.ledger || shared, seconds) });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, () => {
    console.log(`AI English Coach on http://localhost:${config.port}${ready() ? '' : '  (not ready: SARVAM_API_KEY is not set)'}`);
    if (!ready()) return;
    // Generate every scripted line now, so they play instantly later.
    const lines = scriptedLines(), t0 = Date.now();
    sarvam.pregenerate(lines).then(({ done, failed }) => console.log(`Pre-generated ${done} scripted voice lines in ${((Date.now() - t0) / 1000).toFixed(1)} s${failed ? ` (${failed} failed)` : ''}; voice cache cost ₹${summarize(shared).tts.inr.toFixed(2)} (shared by all conversations)`));
  });
}
