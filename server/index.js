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
import { withLedger, summarize, shared, addSpeechToText, spentToday } from './costs.js';
import { production, teamTools, LIMITS, isTeamPath, clientIp, sessionStarts, maySpeak } from './guard.js';
import * as accounts from './accounts.js';
import * as recordings from './recordings.js';
import { loginEnabled } from './auth.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import * as settings from './settings.js';
import { handleLearn } from './learning/api.js';
import { handleAdmin } from './admin/api.js';
import { handleLogin } from './login.js';
import * as payments from './payments.js';
import { handleBuilds } from './builds.js'; // pre-production only: remove before launch
import * as lessons from './learning/lessons.js';
import * as evalRuns from './learning/evalRuns.js';
import { requestId, logRequest } from './http.js';

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

// The scoring trace and the cost are for the team view; a public server keeps them to itself.
const withTeamData = (turn, trace, s) => (teamTools ? { ...turn, trace: trace.list, serverMs: trace.total(), cost: summarize(s.ledger) } : turn);

async function handleSessionStart(req, res) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  if (production && spentToday() >= LIMITS.dailyBudgetInr) {
    console.warn(`[guard] daily budget reached (₹${spentToday().toFixed(0)} of ₹${LIMITS.dailyBudgetInr}): refusing new conversations`);
    return send(res, 503, { error: 'busy', reason: 'Sakhi is very busy today. Please try again tomorrow.' });
  }
  // Phone login and the required consents come first (when login is on).
  const { user } = await accounts.identify(req);
  const missing = await accounts.missingConsents(user);
  if (missing.length) return send(res, 403, { error: 'consent_required', missing });
  if (production && !sessionStarts.hit(user?.id || clientIp(req))) return send(res, 429, { error: 'too many conversations', reason: 'Please wait a while before starting again.' });
  const trace = makeTrace();
  const turn = startSession();
  const s = getSession(turn.sessionId);
  await accounts.testStarted(s, { user, client: req.headers['x-sakhi-client'] || 'web', appVersion: req.headers['x-sakhi-version'] || null });
  send(res, 200, withTeamData(turn, trace, s));
}

/** The conversation, if it belongs to the caller (any caller when login is off). */
async function ownSession(req, sessionId) {
  const s = getSession(sessionId);
  if (!s) return { s: null };
  const { user } = await accounts.identify(req);
  if (loginEnabled() && s.userId !== user?.id) throw Object.assign(new Error('not your conversation'), { status: 403 });
  return { s, user };
}

async function handleSessionTurn(req, res) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  const body = await json(req);
  const { s } = await ownSession(req, body.sessionId);
  if (!s) return send(res, 404, { error: 'session not found (it may have expired); start again' });
  if (production && (s.turnCount = (s.turnCount || 0) + 1) > LIMITS.turnsPerSession) return send(res, 429, { error: 'conversation too long' });
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
  send(res, 200, withTeamData(turn, trace, s));
  accounts.afterTurn(s, { event: body.event }); // saved after the reply, so it adds no delay
}

// POST /api/tts/stream {text, lang, pace, sessionId?} → raw 16-bit PCM, mono, streamed as Bulbul generates it.
// With a sessionId, a generated line is charged to that conversation.
async function handleTTSStream(req, res) {
  const { text, lang = 'en-IN', pace = 1, sessionId } = await json(req);
  const s = sessionId ? (await ownSession(req, sessionId)).s : (await accounts.identify(req), null);
  if (typeof text !== 'string' || !maySpeak(text, s, fixedLines())) return send(res, 403, { error: 'not a line Sakhi said' });
  return withLedger(s?.ledger || shared, () => speakTo(res, { text, lang, pace }));
}

// ---- The customer: /api/me (profile, consents, properties, erase) and /api/events ------------------
// GET    /api/me                    → { id, phone, name, attributes, consents, missingConsents }
// POST   /api/me/consents           { consents: [{ purpose, version, granted }] }
// PATCH  /api/me/attributes         { attributes: { key: value | null }, source?: 'signup' | 'app' }
// POST   /api/events                { events: [{ name, properties?, clientEventId, occurredAt?, sessionId? }] }
// DELETE /api/me                    → erases everything personal, including the recordings and the login
async function handleAccount(req, res, url) {
  const { user } = await accounts.identify(req, { required: true });
  if (!user?.id) return send(res, 503, { error: 'customer data is not set up on this server' });
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/me') return send(res, 200, await accounts.me(user));
  if (route === 'POST /api/me/consents') return send(res, 200, await accounts.saveConsents(user, (await json(req)).consents));
  if (route === 'PATCH /api/me/attributes') { const b = await json(req); return send(res, 200, await accounts.saveAttributes(user, b.attributes, b.source)); }
  if (route === 'POST /api/events') return send(res, 200, await accounts.saveEvents(user, (await json(req, 256 * 1024)).events));
  if (route === 'DELETE /api/me') { await payments.cancelAllFor(user.id); return send(res, 200, await accounts.erase(user)); } // no more charges, then erase
  send(res, 404, { error: 'not found' });
}

let fixed = null;
const fixedLines = () => (fixed ||= new Set(scriptedLines().map((l) => l.text)));

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

// The admin console's own address (ADMIN_HOST, e.g. admin.adamspeaks.in: a Firebase Hosting site that forwards
// everything here; deploy/admin-domain-setup.sh). There, "/" is the console; elsewhere, /admin/ redirects to it.
// Firebase Hosting passes the address people typed in X-Forwarded-Host.
export function requestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}
function adminHostRoute(req, res, pathname) {
  const admin = (process.env.ADMIN_HOST || '').trim().toLowerCase();
  if (!admin) return null;
  const onAdmin = requestHost(req) === admin;
  if (onAdmin && pathname === '/') return '/admin/';
  if (!onAdmin && (pathname === '/admin' || pathname === '/admin/')) { res.writeHead(301, { location: `https://${admin}/` }); res.end(); return true; }
  return null;
}

async function serveStatic(res, pathname) {
  if (pathname === '/admin') { res.writeHead(301, { location: '/admin/' }); return res.end(); }
  const rel = pathname === '/' ? 'public/index.html' : pathname === '/admin/' ? 'public/admin/index.html' : pathname.startsWith('/shared/') ? pathname.slice(1) : `public${pathname}`;
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

// The learning module and the admin console: request ids, one JSON log line per request, the same error shape.
async function handleApi(req, res, url, fn) {
  const rid = requestId(req, res), t0 = performance.now();
  let status = 200;
  try { await fn(); status = res.statusCode; }
  catch (e) {
    status = e.status || 500;
    if (status >= 500) console.error(`[${rid}]`, e);
    if (!res.headersSent) send(res, status, { error: status >= 500 && !e.reason ? 'Something went wrong' : e.message, reason: e.reason, requestId: rid });
    else res.end();
  } finally { logRequest({ rid, req, status, ms: Math.round(performance.now() - t0), user: res.locals?.user }); }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/learn/')) return handleApi(req, res, url, () => handleLearn(req, res, url, { speak: speakTo }));
  if (url.pathname.startsWith('/api/admin/')) return handleApi(req, res, url, () => handleAdmin(req, res, url));
  if (url.pathname.startsWith('/api/auth/')) return handleApi(req, res, url, () => handleLogin(req, res, url));
  if (url.pathname.startsWith('/api/pay/') || url.pathname === '/api/razorpay/webhook') return handleApi(req, res, url, () => payments.handlePayments(req, res, url));
  try {
    if (url.pathname.startsWith('/internal') && await handleBuilds(req, res, url)) return; // pre-production only
    if (isTeamPath(url.pathname)) return send(res, 404, { error: 'not found' });
    // /api/health for Cloud Run (it reserves paths ending in "z", like /healthz, for itself); /healthz for local use.
    if (req.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/healthz')) return send(res, 200, { ok: true, ready: ready() });
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, ready() ? { ready: true } : { ready: false, reason: 'SARVAM_API_KEY is not set on the server' });
    }
    if (url.pathname.startsWith('/api/me') || url.pathname === '/api/events') return await handleAccount(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/session') return await handleSessionStart(req, res);
    if (req.method === 'POST' && url.pathname === '/api/session/turn') return await handleSessionTurn(req, res);
    if (req.method === 'GET' && url.pathname === '/api/session/cost') {
      const s = getSession(url.searchParams.get('id'));
      return s ? send(res, 200, summarize(s.ledger)) : send(res, 404, { error: 'session not found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/tts/stream') return await handleTTSStream(req, res);
    if (req.method === 'POST' && url.pathname === '/api/lab/transcribe') return await handleLabTranscribe(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/lab/compare') return await handleLabCompare(req, res);
    if (req.method === 'GET') {
      const admin = adminHostRoute(req, res, url.pathname);
      if (admin === true) return;
      return await serveStatic(res, admin || url.pathname);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!(e.status >= 400 && e.status < 500)) console.error(e); // a refused request (401, 403, 400…) isn't a server error
    send(res, e.status || 502, { error: e.name === 'AbortError' ? 'Upstream timeout' : e.message });
  }
});

// Audio the relay sends to Sarvam is charged to the conversation the browser says it belongs to.
// In production, audio is only relayed for a live conversation, up to its listening limit.
attachLiveRelay(server, {
  enabled: ready,
  lab: teamTools,
  // With login on, the socket needs the same login token as every request (Authorization header).
  authorize: async (req) => (await accounts.identify(req)).user,
  onAudio: (sessionId, seconds, pcm, user) => {
    const s = getSession(sessionId);
    if (loginEnabled() && (!s || s.userId !== user?.id)) return false;
    if (production) {
      if (!s) return false;
      if ((s.listenSec = (s.listenSec || 0) + seconds) > LIMITS.listenSecPerSession) return false;
    }
    if (s) recordings.collect(s, pcm);
    addSpeechToText(s?.ledger || shared, seconds);
    return true;
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A public server must know who's speaking and keep what they do. SAKHI_ALLOW_NO_LOGIN=1 is for a closed test
  // without accounts (nothing about customers is stored then).
  if (production && process.env.SAKHI_ALLOW_NO_LOGIN !== '1') {
    const missing = [!loginEnabled() && 'a login (MSG91_AUTHKEY + MSG91_WIDGET_ID + SESSION_SECRET, or FIREBASE_PROJECT_ID)', !pool && 'DATABASE_URL'].filter(Boolean);
    if (missing.length) { console.error(`Refusing to start in production without ${missing.join(' and ')} (or set SAKHI_ALLOW_NO_LOGIN=1 for a closed test).`); process.exit(1); }
  }
  if (pool) {
    await migrate(pool);
    await settings.load();
    await lessons.sync();
    await evalRuns.cleanUp();
  }
  server.listen(config.port, () => {
    console.log(`AI English Coach on http://localhost:${config.port}${production ? ' (production)' : ''}${ready() ? '' : '  (not ready: SARVAM_API_KEY is not set)'}`);
    if (!ready() || process.env.SAKHI_SKIP_WARMUP === '1') return; // skipping is for local development
    // Generate every scripted line now, so they play instantly later.
    const lines = scriptedLines(), t0 = Date.now();
    sarvam.pregenerate(lines).then(({ done, failed, stored }) => console.log(`Pre-generated ${done} scripted voice lines in ${((Date.now() - t0) / 1000).toFixed(1)} s (${stored} from the voice store, ${done - stored} new)${failed ? ` (${failed} failed)` : ''}; voice cache cost ₹${summarize(shared).tts.inr.toFixed(2)} (shared by all conversations)`));
  });
}

// Cloud Run stops an instance with SIGTERM and allows ~10 s: stop taking new requests and let replies finish.
process.on('SIGTERM', () => {
  console.log('SIGTERM: finishing open requests');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
});
