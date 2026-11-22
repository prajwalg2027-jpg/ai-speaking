// The conversation, browser side. The server runs the conversation (server/session.js): it remembers what the
// learner said, chooses what comes next, and writes Sakhi's lines. This file handles audio and drives the screen
// (ui.js, orb.js): it plays Sakhi's turn and reveals her words as she says them, shows the task card on its cue
// word, listens (Sarvam Realtime STT), plays a quick reaction the moment the learner stops, and sends the turn.
//
// The customer view (mobile) is the default. /?internal=1 turns on the team view (log, cost, help chips) and
// remembers it; /?internal=0 turns it off.
import { PHRASES } from '/shared/assessment.js';
import { Voice, readBody } from '/audio.js';
import { LiveSTT } from '/live.js';
import { log, initLogPanel } from '/log.js';
import { startCostMeter, stopCostMeter, render as showCost, initCostMeter } from '/cost.js';
import { createUI } from '/ui.js';
import { createOrb } from '/orb.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const params = new URLSearchParams(location.search);

// ---------- which view ----------
const VIEW_KEY = 'sakhi.view';
try {
  if (params.has('internal')) localStorage.setItem(VIEW_KEY, params.get('internal') === '0' ? 'customer' : 'internal');
} catch { /* storage unavailable */ }
let internal = params.get('internal') === '1';
try { internal = internal || (localStorage.getItem(VIEW_KEY) === 'internal' && params.get('internal') !== '0'); } catch { /* ignore */ }
document.body.classList.toggle('internal', internal);
if (internal) $('logs').hidden = false;
initLogPanel($('logs'));
initCostMeter();

let sessionId = null; // the conversation: voice and audio are charged to it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const orb = createOrb(app);
const ui = createUI(app, { onRestart: () => location.reload() });
const setState = (st) => { if (app.dataset.state !== st) log('state', `${app.dataset.state} → ${st}`); ui.setState(st); };

const voice = new Voice((lvl) => orb.setLevel(lvl));
let live = null;
let chipAction = null; // set by chip taps, consumed by the loop
let tapInterrupt = false; // the orb was tapped while Sakhi spoke: treated like talking over her
const backchannels = []; // short reactions, fetched once and played instantly

// ---------- speaking (streamed from Bulbul through the server) ----------
/**
 * Say one line. Its words appear in step with the voice: Bulbul gives no word timings, so each word's time is
 * its share of the line's characters times the audio length (estimated until the whole clip has arrived).
 * onWord(n) is called as the n-th word is reached (the task card appears on its cue word).
 */
async function speak(line, { onWord } = {}) {
  const bubble = ui.sakhiLine(line.text, line.lang);
  log('tts', `Sakhi says (${line.lang}${line.pace !== 1 ? `, pace ${line.pace}` : ''})`, line.text);
  const words = line.text.split(/\s+/).filter(Boolean);
  const chars = words.reduce((n, w) => n + w.length + 1, 0);
  const starts = []; let acc = 0;
  for (const w of words) { starts.push(acc / chars); acc += w.length + 1; }
  const estimate = chars / 14 / (line.pace || 1); // about 14 characters a second
  let shown = 0;
  const show = (n) => { if (n <= shown) return; shown = n; bubble.reveal(n); onWord?.(n); };
  const t = performance.now();
  try {
    const res = await fetch('/api/tts/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...line, sessionId }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const cached = res.headers.get('x-tts-cached') === 'true';
    const onFirst = () => {
      setState('speaking');
      log('tts', cached ? `Voice from server cache: playing after ${Math.round(performance.now() - t)} ms` : `First audio from Bulbul (streaming): playing after ${Math.round(performance.now() - t)} ms`);
    };
    const r = await voice.playPcm(readBody(res, onFirst), Number(res.headers.get('x-sample-rate')) || 24000, {
      onProgress: ({ played, total, complete }) => {
        const T = complete ? total : Math.max(total, estimate);
        let n = 0; while (n < starts.length && starts[n] * T <= played + 0.05) n++;
        show(n);
      },
    });
    const cut = r?.stoppedBy === 'barge-in' || (r?.stoppedBy && tapInterrupt);
    if (cut) { bubble.cut(Math.max(1, shown)); orb.duck(); return { ...r, stoppedBy: 'barge-in' }; }
    show(words.length); bubble.finish();
    return r;
  } catch (e) {
    // No backup voice: the line stays on screen, and the conversation carries on.
    log('error', `Voice failed: ${e.message}. The line is shown as text only.`);
    show(words.length); bubble.finish();
    await sleep(1500);
    return null;
  }
}

async function loadBackchannels() {
  await Promise.all(PHRASES.backchannels.map(async (text) => {
    try {
      const res = await fetch('/api/tts/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang: 'en-IN', pace: 1 }) });
      if (res.ok) backchannels.push({ text, pcm: trimSilence(new Uint8Array(await res.arrayBuffer())), rate: Number(res.headers.get('x-sample-rate')) || 24000 });
    } catch { /* optional */ }
  }));
  log('tts', `Loaded ${backchannels.length} quick reactions`, backchannels.map((b) => b.text));
}

/** Cut the quiet lead-in and tail from a 16-bit PCM clip, so a short reaction starts and stops crisply. */
function trimSilence(pcm) {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.length & ~1), n = v.byteLength >> 1, quiet = 500, pad = 960; // 40 ms
  let a = 0, b = n - 1;
  while (a < n && Math.abs(v.getInt16(a * 2, true)) < quiet) a++;
  while (b > a && Math.abs(v.getInt16(b * 2, true)) < quiet) b--;
  if (a >= b) return pcm;
  return pcm.slice(Math.max(0, a - pad) * 2, Math.min(n, b + pad) * 2);
}

/**
 * A soft "Mm-hmm." while the reply is prepared, so there's no dead air. Said like a person would: a beat after
 * they stop (not the instant), quieter than a full line, about every other time (not after every answer), never
 * the same one twice in a row, and only if the reply isn't already here.
 */
let lastBackchannel = null;
const BACKCHANNEL_CHANCE = 0.5;
function backchannel(replyReady) {
  if (!backchannels.length) return { played: Promise.resolve(null), text: () => null };
  let said = null;
  const played = sleep(350).then(() => {
    if (replyReady() || Math.random() >= BACKCHANNEL_CHANCE) return null;
    const pool = backchannels.length > 1 ? backchannels.filter((b) => b.text !== lastBackchannel) : backchannels;
    const b = pool[Math.floor(Math.random() * pool.length)];
    said = lastBackchannel = b.text;
    log('tts', `Quick reaction while the reply is prepared: "${b.text}"`);
    return voice.playPcm([b.pcm], b.rate, { volume: 0.6 });
  });
  return { played, text: () => said };
}

// Sakhi's own replies often open with the same kind of word ("Okay! ..."). After a quick reaction, that opening
// is dropped so she doesn't say "Mm-hmm." and then "Okay!" straight after.
const ACK = /^\s*(?:okay|ok|alright|all right|right|got it|i see|hmm+|mm-?hmm|mhm|aha|uh-?huh|achha|great|nice|good|thanks|thank you)(?:[,\s]+(?:okay|thanks|thank you|got it))?\s*[.!]+\s+/i;
function dropRepeatedAck(turn) {
  const first = turn.say?.[0];
  const m = first && first.lang === 'en-IN' && first.text.match(ACK);
  if (!m || !first.text.slice(m[0].length).trim()) return;
  const cut = m[0].trim().split(/\s+/).length;
  log('tts', `Dropped "${m[0].trim()}" from the start of the reply (a quick reaction was just said)`);
  turn.say[0] = { ...first, text: first.text.slice(m[0].length) };
  if (turn.cue && turn.cue.line === 0) turn.cue = { ...turn.cue, word: Math.max(0, turn.cue.word - cut) };
}

// ---------- haptics ----------
// The phone vibrates when it's the learner's turn to speak, and a lighter tap when Sakhi has their answer and is
// working on it. Android supports this (navigator.vibrate); iPhones ignore it. ?haptics=0 in the URL turns it off.
const HAPTICS = { 'your-turn': [45], 'got-it': [18] };
const hapticsOn = params.get('haptics') !== '0';
function haptic(kind) {
  if (!hapticsOn || !navigator.vibrate) return;
  try { if (navigator.vibrate(HAPTICS[kind])) log('app', `Vibrate: ${kind === 'your-turn' ? "your turn to speak" : 'got your answer'}`); } catch { /* not allowed */ }
}

// ---------- listening ----------
async function listen({ silenceMs, language }) {
  // No "your turn" buzz after an interruption: they're already talking.
  if (live.bargeInAt == null) haptic('your-turn');
  setState('listening');
  const bubble = ui.youLive();
  if (!(await live.ensureConnected())) {
    log('error', 'Could not reconnect to Sarvam Realtime', live.reason);
    bubble.final('');
    return { reason: 'live_failed', transcript: '', speechSec: 0 };
  }
  const r = await live.listen({ silenceMs, language, onNudge: () => ui.setWait(true), onPartial: (t) => bubble.partial(t) });
  bubble.final(r.reason === 'no_speech' || r.reason === 'live_failed' ? '' : r.transcript);
  if (r.transcript) haptic('got-it'); // they finished speaking; the answer is being processed
  return r;
}

// ---------- the server conversation ----------
async function api(path, body) {
  const t = performance.now();
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) { log('error', `${path} failed: HTTP ${res.status}`, r.error); throw new Error(r.error || `HTTP ${res.status}`); }
  for (const step of r.trace || []) logTraceStep(step);
  showCost(r.cost);
  log('turn', `Server replied in ${r.serverMs} ms (${Math.round(performance.now() - t)} ms round trip)${r.task ? `: next task ${r.task.id} (level ${r.task.level})` : ''}`);
  return r;
}

// Turn one server trace step into a readable log line.
const TRACE_CAT = { understand: 'llm', continues: 'llm', interrupted: 'app', profile: 'app', judge: 'llm', tutor: 'llm', 'tutor-fallback': 'error', 'tutor-retry': 'llm', features: 'score', heuristic: 'score', scores: 'score', plan: 'app' };
function logTraceStep(st) {
  const { step, at, ms, error, ...d } = st;
  const p = `server +${at} ms · `;
  if (error) return log('error', `${p}${step} failed after ${ms} ms: ${error}`);
  const msg = {
    input: () => `${p}learner turn: ${d.event}`,
    question: () => `${p}evaluating ${d.id} (level ${d.level})`,
    check: () => `${p}${d.result}: ${d.why}`,
    clarify: () => d.intent ? `${p}request for help: ${d.intent} (${d.by})` : `${p}not a request for help: scoring as an answer`,
    understand: () => `${p}${d.model} read the reply as "${d.intent}" in ${ms} ms${d.name ? ` · name: ${d.name}` : ''}${d.language ? ` · asked for ${d.language}` : ''}`,
    profile: () => `${p}remembered about the learner: ${[d.name && `name ${d.name}`, d.language && `talks in ${d.language}`, ...(d.facts || [])].filter(Boolean).join('; ')}`,
    features: () => `${p}speech features measured`,
    heuristic: () => `${p}feature-based scores (0–4)`,
    judge: () => `${p}${d.model} rubric scores in ${ms} ms`,
    scores: () => `${p}answer scores for ${d.task} (${d.blend})`,
    tutor: () => `${p}${d.model} wrote Sakhi's next line in ${ms} ms (${d.situation})`,
    interrupted: () => `${p}learner talked over Sakhi after: "${d.heard}"${d.askHeard ? '' : ' (before her question)'}`,
    continues: () => `${p}${d.model} checked in ${ms} ms: ${d.continues ? 'still finishing the previous answer' : 'a reply to what Sakhi said'}`,
    'tutor-retry': () => `${p}tutor line rejected (${d.reason}): asking again`,
    'tutor-fallback': () => `${p}tutor line rejected (${d.reason}): using the scripted line`,
    plan: () => `${p}${d.next ? `next: ${d.next}` : ''}${d.why ? ` (${d.why})` : ''}${d.level ? ` · level ${d.level}` : ''}${d.discarded ? ` · discarded ${d.discarded}` : ''}`,
  }[step]?.() || `${p}${step}`;
  log(TRACE_CAT[step] || 'turn', msg, Object.keys(d).length ? d : undefined);
}

async function run() {
  if (internal) $('chips').hidden = false;
  loadBackchannels();
  let turn = await api('/api/session', {});
  sessionId = turn.sessionId;
  live.bind(sessionId);
  if (internal) startCostMeter(sessionId); // the cost is team-only (a production server refuses it)
  log('app', 'Conversation started', { sessionId });
  ui.setSession('live');
  setState('thinking');
  await sleep(500);

  for (;;) {
    chipAction = null; tapInterrupt = false;
    live.beginPrompt();
    ui.setLanguage(turn.learnerLanguage);
    // The task card: a new card appears (or is dealt) on its cue word; no card in this turn puts it away; the
    // same card stays still. Help in Hindi locks its instruction to Hindi.
    const nextCard = turn.card, shownCard = ui.cardShown;
    const changeCard = nextCard && (!shownCard || shownCard.text !== nextCard.text);
    if (!nextCard && shownCard && !turn.done) ui.exitCard();
    if (nextCard && !changeCard && turn.say.some((l) => l.lang === 'hi-IN')) ui.lockHindi();
    let cardShown = !changeCard;
    const cue = turn.cue || { line: 0, word: 0 };
    const showCard = () => { if (!cardShown) { cardShown = true; ui.showCard(nextCard); } };

    // The learner talking over Sakhi ends her whole turn, not just the current line. The server is told how
    // much of it they heard, so it knows whether they heard the question.
    let interrupted = null;
    for (let i = 0; i < turn.say.length; i++) {
      if (chipAction) break;
      if (turn.done && i === 0) ui.exitCard();
      const r = await speak(turn.say[i], { onWord: (n) => { if (i === cue.line && n > cue.word) showCard(); } });
      if (i >= cue.line) showCard();
      if (r?.stoppedBy === 'barge-in') {
        interrupted = { index: i, heardSec: r.heardSec };
        log('app', `Learner interrupted after ${r.heardSec} s of line ${i + 1} of ${turn.say.length}: skipping the rest of Sakhi's turn`);
        break;
      }
    }
    if (!turn.done) showCard();
    if (turn.done && !interrupted) { stopCostMeter(5000); return showResult(turn.done); }
    // Talking over the closing summary usually means they were still finishing their last answer: listen.
    if (turn.done) log('app', 'Learner talked over the summary: listening in case they were still answering');

    const rec = chipAction ? { reason: 'manual' } : await listen(turn.listen || { silenceMs: 1400, language: 'auto' });
    let input;
    if (chipAction) input = { event: chipAction };
    else if (rec.reason === 'no_speech') input = { event: 'no_speech' };
    else if (rec.reason === 'live_failed') input = { event: 'live_failed' };
    else input = { event: 'answer', transcript: rec.transcript, languageCode: rec.language, speechSec: rec.speechSec, ...(rec.timing ? { timing: rec.timing } : {}), ...(interrupted ? { interrupted } : {}) };
    if (input.event === 'in_hindi') ui.lockHindi();
    chipAction = null;

    if (input.event === 'answer' && input.transcript) ui.cardAnswered();
    const words = (input.transcript || '').trim().split(/\s+/).filter(Boolean).length;
    let replied = false;
    const reacting = input.event === 'answer' && words >= 3 ? backchannel(() => replied) : null;
    setState('thinking');
    ui.sent();
    turn = await api('/api/session/turn', { sessionId, ...input });
    replied = true;
    if (reacting) { await reacting.played; if (reacting.text()) dropRepeatedAck(turn); }
  }
}

function showResult(result) {
  log('score', `Final placement: level ${result.level} (${result.name}), adjusted score ${result.overall}`, result);
  $('chips').hidden = true;
  ui.result(result);
}

// ---------- wiring ----------
$('chips').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  log('app', `Tapped "${e.target.closest('button').querySelector('.lb')?.textContent.trim() || act}"`);
  if (act === 'done') return voice.stopListening?.(false); // wait for the final transcript
  chipAction = act;
  voice.stopPlayback?.();
  voice.stopListening?.(true);
});

let started = false;
async function start() {
  started = true;
  ui.notice(false); ui.micError(false);
  try {
    log('app', 'Session started');
    const cfg = await fetch('/api/config').then((r) => r.json());
    log('app', 'Server config', cfg);
    if (!cfg.ready) throw Object.assign(new Error(cfg.reason || 'Server is not configured'), { connection: true });
    if (!voice.ctx) await voice.init({ noiseSuppression: params.get('ns') !== '0', autoGainControl: params.get('agc') !== '0' });
    live = new LiveSTT(voice);
    // An interruption: listening sends audio from where the learner started talking (live.js).
    voice.onBargeIn = (onsetAt) => { live.bargeInAt = onsetAt; orb.duck(); };
    if (!(await live.connect())) throw Object.assign(new Error(`Sarvam Realtime unavailable: ${live.reason}`), { connection: true });
    log('live', 'Connected: speech-to-text is Sarvam Realtime (streams only while listening)');
    await run();
  } catch (e) {
    log('error', `Session stopped: ${e.message}`);
    stopCostMeter();
    live?.close(); live = null;
    started = false;
    setState('idle'); ui.setSession('idle');
    // Never red, never a modal: the microphone screen, or an inline notice and the orb dims.
    if (e.name === 'NotAllowedError' || e.name === 'NotFoundError' || e.name === 'SecurityError') ui.micError(true, () => start());
    else ui.notice(true);
  }
}

$('orb').addEventListener('click', () => {
  orb.press();
  if (!started) return start();
  const state = app.dataset.state;
  if (state === 'speaking') { tapInterrupt = true; return voice.stopPlayback?.(); } // tap = interrupt Sakhi
  if (state === 'listening') return voice.stopListening?.(false); // tap = done speaking
});
