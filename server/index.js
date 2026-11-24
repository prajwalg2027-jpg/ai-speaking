// HTTP server: static files, the conversation API, streamed voice, the STT lab, and the /api/live relay.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ready } from './config.js';
import * as sarvam from './sarvam.js';
import { joinLines, mapInterruption } from './voicejoin.js';
import { attachLiveRelay } from './live.js';
import { readAccuracy } from './scoring.js';
import { normalizeForCompare } from './normalize.js';
import { makeTrace } from './trace.js';
import { startSession, getSession, handleTurn, scriptedLines } from './placement/index.js'; // classic or conversation (Settings)
import * as resume from './placement/resume.js';
import * as store from './store.js';
import { buildInsights, sayable, sayBackScore } from './placement/insights.js';
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
import { expireSummaries } from './learning/memory.js';
import { requestId, logRequest } from './http.js';
import * as diag from './diag.js';

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
//   With "Accept: application/x-ndjson" the turn comes in parts, one JSON object a line, so the app can start
//   saying her reaction while the rest of her turn is still being written (the conversation, a model that streams):
//     {"part":"reply","say":[lines]}   her reaction, the moment it is known (not always sent)
//     {"part":"turn", ...the turn}     the whole turn, as without streaming; its say begins with those lines
//     {"part":"error","error","status"} instead of the turn, if it failed after the reaction had been sent
// Each turn: { say: [{text, lang, pace}], card, listen: {silenceMs, language} | null, done?, heard?, trace, serverMs, cost }
//   seq: the turn's number in the test (1, 2, …). A turn sent again with the same seq (the app lost the answer
//   on a weak connection) gets the same answer again; it is not taken as a new turn.
// POST /api/session/resume     → body {sessionId?} → a test the learner left midway, carried on: Sakhi welcomes
//   them back and asks the question they were on again ({ ...turn, resumed: true, seq: the last turn's seq }), or
//   404 { error: 'nothing_to_resume' }. Their latest test within Settings › Limits › resumeHours (24 h) when the
//   one named is gone. Starting a new test (POST /api/session) is "start over": the test left midway is abandoned.
// GET  /api/session/resume     → { open: true, sessionId } when there is a test to carry on (nothing is said), else { open: false }
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
  if (user?.id) await store.abandonTests({ userId: user.id, keep: s.id }); // a new test: the one left midway won't be carried on
  send(res, 200, withTeamData(turn, trace, s));
  diag.record(req, [{ name: 'session.started', sid: turn.sessionId, data: { mode: s.mode, say: (turn.say || []).map((l) => l.text) } }]);
}

/** The conversation, if it belongs to the caller (any caller when login is off). */
async function ownSession(req, sessionId) {
  let s = getSession(sessionId);
  const { user } = await accounts.identify(req);
  // Not held any more (a server release, or two hours away): the saved test, within the resume window.
  if (!s && sessionId) s = await resume.loadTest(String(sessionId), user?.id || null);
  if (!s) return { s: null };
  if (loginEnabled() && s.userId !== user?.id) throw Object.assign(new Error('not your conversation'), { status: 403 });
  return { s, user };
}

async function handleSessionTurn(req, res) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  const body = await json(req);
  const { s } = await ownSession(req, body.sessionId);
  if (!s) return send(res, 404, { error: 'session not found (it may have expired); start again' });
  const seq = Number.isInteger(body.seq) && body.seq > 0 ? body.seq : null;
  if (seq != null && seq <= (s.seq || 0)) {
    // Sent again: the app didn't get the answer (a weak connection). The same answer, once it is written.
    if (s.inFlight?.seq === seq) await s.inFlight.done;
    if (s.lastTurn?.seq === seq) {
      const again = withTeamData({ ...s.lastTurn.turn, again: true }, makeTrace(), s);
      if (!/application\/x-ndjson/.test(String(req.headers.accept || ''))) return send(res, 200, again);
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`${JSON.stringify({ part: 'turn', ...again })}\n`);
    }
    return send(res, 409, { error: 'an earlier turn', seq: s.seq || 0 });
  }
  if (production && (s.turnCount = (s.turnCount || 0) + 1) > LIMITS.turnsPerSession) return send(res, 429, { error: 'conversation too long' });
  const before = s.seq || 0;
  let finished;
  if (seq != null) { s.seq = seq; s.inFlight = { seq, done: new Promise((ok) => { finished = ok; }) }; }
  let turn = null;
  try { turn = await runTurn(req, res, body, s); }
  finally {
    if (seq != null) {
      if (turn) s.lastTurn = { seq, turn }; else s.seq = before; // failed: the same seq may be sent again
      s.inFlight = null; finished();
    }
  }
}

/** One turn of the test (handleSessionTurn). → the turn sent, or null if it failed after her reaction was sent. */
async function runTurn(req, res, body, s) {
  const trace = makeTrace();
  trace.add('input', { event: body.event, via: 'transcript from Realtime STT', languageCode: body.languageCode ?? null });
  // An app that asks for the turn in parts gets her reaction as soon as it is known (see the route's note above).
  const inParts = /application\/x-ndjson/.test(String(req.headers.accept || ''));
  const part = (o) => {
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.write(`${JSON.stringify(o)}\n`);
  };
  const speakAhead = (lines) => { for (const l of lines) sarvam.streamSpeech(l.text, { lang: l.lang, pace: l.pace }).catch(() => {}); };
  // One voice request per turn (a Google voice, and the admin setting): her lines are joined once the turn is
  // written, so her reaction is neither voiced nor sent ahead on its own.
  const join = joinTurns();
  const interrupted = body.interrupted ? { index: Number(body.interrupted.index) || 0, heardSec: Number(body.interrupted.heardSec) || 0 } : null;
  let turn;
  try {
    turn = await withLedger(s.ledger, () => handleTurn(s, {
      event: body.event, transcript: String(body.transcript || ''), languageCode: body.languageCode || null, speechSec: Number(body.speechSec) || 0,
      // Set when the learner talked over Sakhi: which of her lines, and how many seconds of it they heard.
      interrupted: join || s.joined ? mapInterruption(s.joined, interrupted, (l) => sarvam.speechSeconds(l.text, l)) : interrupted,
      // Measured from the mic while they spoke (fluency): see features() in scoring.js.
      timing: body.timing && Number.isFinite(Number(body.timing.spanSec)) ? {
        spanSec: Number(body.timing.spanSec), voicedSec: Number(body.timing.voicedSec) || 0,
        pauses: (Array.isArray(body.timing.pauses) ? body.timing.pauses : []).slice(0, 200).map(Number).filter(Number.isFinite),
      } : null,
    }, trace, {
      // A model that streams: her reaction is known before the turn is finished, so its voice is generated now.
      // By the time the app asks for the line it is ready, or well on its way (the app joins it).
      onReply: join ? null : speakAhead,
      // ... and it is sent to an app that takes the turn in parts, which starts saying it at once. From then on
      // it is her reaction for this turn (conversation.js keeps to it).
      commit: inParts && !join ? (lines) => { part({ part: 'reply', say: lines }); return true; } : null,
    }));
  } catch (e) {
    if (!res.headersSent) throw e; // nothing sent yet: the usual error answer
    console.error(`[turn] failed after her reaction was sent: ${e.message}`);
    res.end(`${JSON.stringify({ part: 'error', error: e.message || 'the turn failed', status: e.status || 500 })}\n`);
    return null;
  }
  // The conversation: the voice for every line of her turn is started now, not when the app comes to each line.
  // The app asks for one line at a time, as it reaches it; without this her question would only start being
  // made after her reply had been played, and she would pause between the two. (A line already made, or being
  // made, is not made again.)
  s.joined = null;
  if (join && turn.say?.length > 1) {
    const fixed = fixedLines(), j = joinLines(turn.say, turn.cue, (t) => fixed.has(t));
    s.joined = { say: j.say, groups: j.groups, original: turn.say };
    s.voiceLines = [...(s.voiceLines || []), ...j.say.map((l) => l.text)].slice(-40);
    turn = { ...turn, say: j.say, ...(turn.cue ? { cue: j.cue } : {}) };
  }
  if (s.mode === 'conversation') withLedger(s.ledger, () => speakAhead(turn.say || []));
  if (inParts) { part({ part: 'turn', ...withTeamData(turn, trace, s) }); res.end(); }
  else send(res, 200, withTeamData(turn, trace, s));
  // A team phone sending diagnostics: what the server made of the turn, step by step, with timings.
  diag.record(req, [{ name: 'turn', sid: s.id, data: { event: body.event, serverMs: trace.total(), say: (turn.say || []).map((l) => l.text),
    listen: turn.listen || null, done: turn.done ? { level: turn.done.level } : null, steps: trace.list } }]);
  accounts.afterTurn(s, { event: body.event }); // saved after the reply, so it adds no delay
  if (turn.done) startInsights(s);
  return turn;
}

// ---- The result screen's detailed feedback (server/placement/insights.js) ----------------------------------
// GET  /api/session/insights?id=…            → the feedback, once written (waits for it, up to about 25 s)
// POST /api/session/sayback?id=…&text=…      body: 16 kHz WAV (≤ 30 s) of the learner saying one of its sentences
//                                            → { heard, score, matched, total, words: [{ t, ok }] }
// It is written in one AI call that starts as soon as the test ends, while Sakhi says goodbye.
function startInsights(s) {
  if (s.insights || !s.result) return;
  const P = settings.get('placement');
  s.insights = withLedger(s.ledger, () => buildInsights(s, { config: P.brain, effort: P.finalEffort })).then((ins) => {
    // Its sentences may be spoken by Sakhi's voice, and said back by the learner.
    s.sayable = sayable(ins);
    s.voiceLines = [...(s.voiceLines || []), ...s.sayable].slice(-80);
    if (ins.meta) console.log(`[insights] ${s.id}: ${ins.meta.provider}/${ins.meta.model} ${ins.meta.ms} ms`);
    if (ins.fallback) console.warn(`[insights] ${s.id}: ${ins.fallback}`);
    const { meta, fallback, ...shown } = ins;
    return shown;
  });
}

async function handleInsights(req, res, url) {
  const { s } = await ownSession(req, url.searchParams.get('id'));
  if (!s) return send(res, 404, { error: 'session not found (it may have expired)' });
  if (!s.done) return send(res, 409, { error: 'the test has not finished' });
  startInsights(s); // a test that ended some other way
  send(res, 200, await s.insights);
}

async function handleSayBack(req, res, url) {
  const { s } = await ownSession(req, url.searchParams.get('id'));
  if (!s) return send(res, 404, { error: 'session not found (it may have expired)' });
  const text = String(url.searchParams.get('text') || '');
  if (!s.sayable?.includes(text)) return send(res, 403, { error: 'not a sentence from your feedback' });
  if ((s.saybacks = (s.saybacks || 0) + 1) > 40) return send(res, 429, { error: 'too many tries; please start learning to practise more' });
  if (production && spentToday() >= LIMITS.dailyBudgetInr) return send(res, 503, { error: 'busy', reason: 'Sakhi is very busy today. Please try again tomorrow.' });
  const wav = await readBody(req, 1_100_000); // 30 s of 16 kHz 16-bit mono, plus the header
  if (wav.length < 44 + 3200) return send(res, 400, { error: 'the recording is too short' });
  const r = await sarvam.transcribe(wav);
  addSpeechToText(s.ledger, (wav.length - 44) / 32000);
  send(res, 200, sayBackScore(text, r.transcript));
}

/** GET /api/session/resume → { open, sessionId? }: is there a test left midway (for the app's start screen; nothing is said). */
async function handleOpenTest(req, res) {
  const { user } = await accounts.identify(req);
  if (!user?.id) return send(res, 200, { open: false });
  const s = await resume.findTest({ userId: user.id, sessionId: null, inMemory: getSession });
  send(res, 200, s && !s.done ? { open: true, sessionId: s.id } : { open: false });
}

async function handleSessionResume(req, res) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  if (production && spentToday() >= LIMITS.dailyBudgetInr) return send(res, 503, { error: 'busy', reason: 'Sakhi is very busy today. Please try again tomorrow.' });
  const body = await json(req);
  const { user } = await accounts.identify(req);
  if (loginEnabled() && !user?.id) return send(res, 404, { error: 'nothing_to_resume' });
  const s = await resume.findTest({ userId: user?.id || null, sessionId: body.sessionId ? String(body.sessionId) : null, inMemory: getSession });
  if (!s) return send(res, 404, { error: 'nothing_to_resume' });
  const away = Date.now() - (s.at || 0);
  s.lastTurn = null; // a turn sent again from before the break gets 409: the app goes on from this turn
  const turn = await resume.resumeTurn(s, away);
  send(res, 200, withTeamData(turn, makeTrace(), s));
  diag.record(req, [{ name: 'session.resumed', sid: s.id, data: { awaySec: Math.round(away / 1000), say: turn.say.map((l) => l.text) } }]);
  accounts.afterTurn(s, { event: 'resume' });
}

// POST /api/tts/stream {text, lang, pace, sessionId?} → raw 16-bit PCM, mono, streamed as the voice is made (Sakhi's voice: admin settings, "voice").
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

/** One voice request per turn: a Google voice is in use and the admin setting is on. */
const joinTurns = () => sarvam.voiceInUse().source !== 'sarvam' && settings.get('voice')?.oneRequestPerTurn !== false;

let fixed = null;
const fixedLines = () => (fixed ||= new Set(scriptedLines().map((l) => l.text)));

async function speakTo(res, { text, lang, pace }) {
  if (!ready()) return send(res, 503, { error: 'Server has no SARVAM_API_KEY' });
  if (!text || text.length > 2500) return send(res, 400, { error: 'text required (max 2500 chars)' });
  const cached = sarvam.isSpeechCached(text, { lang, pace });
  let started = false;
  const voice = sarvam.voiceInUse();
  const start = () => {
    if (started) return; started = true;
    res.writeHead(200, { 'content-type': 'audio/pcm', 'x-sample-rate': String(sarvam.TTS_RATE), 'x-tts-cached': String(cached), 'x-tts-model': voice.model, 'x-tts-speaker': voice.voice, 'x-tts-source': voice.source, 'cache-control': 'no-store' });
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
  // The learner app is the Android app; the server's own address has no page of its own, so send visitors to the website.
  if (pathname === '/') { res.writeHead(302, { location: 'https://adamspeaks.in/' }); return res.end(); }
  // /admin and /admin/ are both the console: adamspeaks.in/admin (Firebase Hosting strips trailing slashes) and the server's own address.
  const rel = pathname === '/admin/' || pathname === '/admin' ? 'public/admin/index.html' : pathname.startsWith('/shared/') ? pathname.slice(1) : `public${pathname}`;
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
  // A team phone sending diagnostics: each of its requests goes into its log, with the status and the time taken.
  if (diag.codeOf(req) && !url.pathname.startsWith('/api/diag/')) {
    const t0 = performance.now();
    res.on('close', () => diag.record(req, [{ name: 'http', data: { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(performance.now() - t0), complete: res.writableFinished } }]));
  }
  if (url.pathname.startsWith('/api/diag/')) return handleApi(req, res, url, () => diag.handleDiag(req, res, url));
  if (url.pathname.startsWith('/api/learn/')) return handleApi(req, res, url, () => handleLearn(req, res, url, { speak: speakTo }));
  if (url.pathname.startsWith('/api/admin/')) return handleApi(req, res, url, () => handleAdmin(req, res, url));
  if (url.pathname.startsWith('/api/auth/')) return handleApi(req, res, url, () => handleLogin(req, res, url));
  if (url.pathname.startsWith('/api/pay/') || url.pathname === '/api/razorpay/webhook' || url.pathname === '/api/play/rtdn') return handleApi(req, res, url, () => payments.handlePayments(req, res, url));
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
    if (req.method === 'GET' && url.pathname === '/api/session/insights') return await handleInsights(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/session/sayback') return await handleSayBack(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/session/resume') return await handleSessionResume(req, res);
    if (req.method === 'GET' && url.pathname === '/api/session/resume') return await handleOpenTest(req, res);
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
    const missing = [!loginEnabled() && 'a login (MSG91_AUTHKEY + MSG91_WIDGET_ID + SESSION_SECRET)', !pool && 'DATABASE_URL'].filter(Boolean);
    if (missing.length) { console.error(`Refusing to start in production without ${missing.join(' and ')} (or set SAKHI_ALLOW_NO_LOGIN=1 for a closed test).`); process.exit(1); }
  }
  if (pool) {
    await migrate(pool);
    await settings.load();
    await lessons.sync();
    await evalRuns.cleanUp();
    // Retention of conversation summaries (Sakhi's memory): now and once a day.
    const expire = () => expireSummaries().then((n) => n && console.log(`[memory] removed ${n} old conversation summaries`)).catch((e) => console.warn('[memory] retention failed:', e.message));
    expire();
    setInterval(expire, 24 * 60 * 60 * 1000).unref();
    // Tests left midway and not carried on within the window are marked abandoned (for the drop-off numbers).
    const expireTests = () => store.expireTests(resume.resumeHours()).catch((e) => console.error('[resume] expiring tests failed:', e.message));
    expireTests(); setInterval(expireTests, 60 * 60 * 1000).unref();
  }
  server.listen(config.port, () => {
    console.log(`AI English Coach on http://localhost:${config.port}${production ? ' (production)' : ''}${ready() ? '' : '  (not ready: SARVAM_API_KEY is not set)'}`);
    if (!ready() || process.env.SAKHI_SKIP_WARMUP === '1') return; // skipping is for local development
    // Generate every scripted line now, so they play instantly later.
    const lines = scriptedLines(), t0 = Date.now();
    // A Google voice on the free trial allows ~10 requests a minute for the whole project: making all the fixed
    // lines in a burst left nothing for learners, and their lines stalled. Paced to 4 a minute, the rest is theirs.
    // (Each clip is made once: the voice store keeps it for every later start.)
    const google = sarvam.voiceInUse().source !== 'sarvam';
    sarvam.pregenerate(lines, google ? { gapMs: 15_000, busyWaitMs: 60_000 } : {}).then(({ done, failed, stored }) => console.log(`Pre-generated ${done} scripted voice lines in ${((Date.now() - t0) / 1000).toFixed(1)} s (${stored} from the voice store, ${done - stored} new)${failed ? ` (${failed} failed)` : ''}; voice cache cost ₹${summarize(shared).tts.inr.toFixed(2)} (shared by all conversations)`));
  });
}

// Cloud Run stops an instance with SIGTERM and allows ~10 s: stop taking new requests and let replies finish.
process.on('SIGTERM', () => {
  console.log('SIGTERM: finishing open requests');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
});
