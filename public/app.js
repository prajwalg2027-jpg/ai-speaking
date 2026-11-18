// The conversation, browser side. The server runs the conversation (server/session.js): it remembers what the
// learner said, chooses what comes next, and writes Sakhi's lines. This file handles audio and the screen:
// it plays Sakhi's turn, listens (Sarvam Realtime STT), plays a quick reaction the moment the learner stops,
// and sends the turn to the server.
import { PHRASES } from '/shared/assessment.js';
import { Voice, readBody } from '/audio.js';
import { LiveSTT } from '/live.js';
import { log, initLogPanel } from '/log.js';
import { startCostMeter, stopCostMeter, render as showCost, initCostMeter } from '/cost.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
initLogPanel($('logs'));
initCostMeter();
let sessionId = null; // the conversation: voice and audio are charged to it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- screen ----------
let liveBubble = null;
const ui = {
  state: (s) => { if (app.dataset.state !== s) log('state', `${app.dataset.state} → ${s}`); app.dataset.state = s; },
  hint: (t) => ($('hint').textContent = t || ''),
  card: (card) => { const c = $('card'); c.hidden = !card; c.textContent = card?.text || ''; c.className = `card ${card?.kind === 'read' ? 'read' : ''}`; },
  bubble(who, text) {
    const el = document.createElement('div');
    el.className = `msg ${who}`; el.textContent = text;
    $('convo').append(el); $('convo').scrollTop = $('convo').scrollHeight;
    return el;
  },
  /** The learner's words as they speak (live captions), then final. */
  hearing(text) {
    if (!text) return;
    liveBubble ||= ui.bubble('you live', '');
    liveBubble.textContent = text; $('convo').scrollTop = $('convo').scrollHeight;
  },
  heard(text) {
    if (liveBubble) { if (text) { liveBubble.textContent = text; liveBubble.classList.remove('live'); } else liveBubble.remove(); }
    else if (text) ui.bubble('you', text);
    liveBubble = null;
  },
};

const voice = new Voice((lvl) => document.documentElement.style.setProperty('--lvl', lvl.toFixed(3)));
let live = null;
let chipAction = null; // set by chip taps, consumed by the loop
const backchannels = []; // short reactions, fetched once and played instantly

// ---------- speaking (streamed from Bulbul through the server) ----------
async function speak(line) {
  ui.state('speaking');
  ui.bubble('sakhi', line.text);
  log('tts', `Sakhi says (${line.lang}${line.pace !== 1 ? `, pace ${line.pace}` : ''})`, line.text);
  const t = performance.now();
  try {
    const res = await fetch('/api/tts/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...line, sessionId }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const cached = res.headers.get('x-tts-cached') === 'true';
    const onFirst = () => log('tts', cached ? `Voice from server cache: playing after ${Math.round(performance.now() - t)} ms` : `First audio from Bulbul (streaming): playing after ${Math.round(performance.now() - t)} ms`);
    return await voice.playPcm(readBody(res, onFirst), Number(res.headers.get('x-sample-rate')) || 24000);
  } catch (e) {
    // No backup voice: the line stays on screen, and the conversation carries on.
    log('error', `Voice failed: ${e.message}. The line is shown as text only.`);
    ui.hint('Voice unavailable: please read Sakhi’s message above.');
    await sleep(1500);
  }
}

async function loadBackchannels() {
  await Promise.all(PHRASES.backchannels.map(async (text) => {
    try {
      const res = await fetch('/api/tts/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang: 'en-IN', pace: 1 }) });
      if (res.ok) backchannels.push({ text, pcm: new Uint8Array(await res.arrayBuffer()), rate: Number(res.headers.get('x-sample-rate')) || 24000 });
    } catch { /* optional */ }
  }));
  log('tts', `Loaded ${backchannels.length} quick reactions`, backchannels.map((b) => b.text));
}

/** A short "Mm-hmm." the moment the learner finishes, so there's no dead air while the reply is prepared. */
function backchannel() {
  if (!backchannels.length) return null;
  const b = backchannels[Math.floor(Math.random() * backchannels.length)];
  log('tts', `Quick reaction while the reply is prepared: "${b.text}"`);
  return voice.playPcm([b.pcm], b.rate);
}

// ---------- listening ----------
async function listen({ silenceMs, language }) {
  ui.state('listening'); ui.hint('Listening…');
  if (!(await live.ensureConnected())) {
    log('error', 'Could not reconnect to Sarvam Realtime', live.reason);
    ui.hint('');
    return { reason: 'live_failed', transcript: '', speechSec: 0 };
  }
  const r = await live.listen({ silenceMs, language, onNudge: () => ui.hint(PHRASES.nudge), onPartial: (t) => ui.hearing(t) });
  ui.hint('');
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
const TRACE_CAT = { understand: 'llm', profile: 'app', judge: 'llm', tutor: 'llm', 'tutor-fallback': 'error', 'tutor-retry': 'llm', features: 'score', heuristic: 'score', scores: 'score', plan: 'app' };
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
    'tutor-retry': () => `${p}tutor line rejected (${d.reason}): asking again`,
    'tutor-fallback': () => `${p}tutor line rejected (${d.reason}): using the scripted line`,
    plan: () => `${p}${d.next ? `next: ${d.next}` : ''}${d.why ? ` (${d.why})` : ''}${d.level ? ` · level ${d.level}` : ''}${d.discarded ? ` · discarded ${d.discarded}` : ''}`,
  }[step]?.() || `${p}${step}`;
  log(TRACE_CAT[step] || 'turn', msg, Object.keys(d).length ? d : undefined);
}

async function run() {
  $('chips').hidden = false;
  loadBackchannels();
  let turn = await api('/api/session', {});
  sessionId = turn.sessionId;
  live.bind(sessionId);
  startCostMeter(sessionId);
  log('app', 'Conversation started', { sessionId });

  for (;;) {
    ui.card(turn.card);
    chipAction = null;
    live.beginPrompt();
    // The learner talking over Sakhi ends her whole turn, not just the current line.
    for (const line of turn.say) {
      if (chipAction) break;
      if ((await speak(line)) === 'barge-in') { log('app', 'Learner interrupted: skipping the rest of Sakhi\'s turn'); break; }
    }
    if (turn.done) { stopCostMeter(5000); return showResult(turn.done); }

    const rec = chipAction ? { reason: 'manual' } : await listen(turn.listen);
    let input;
    if (chipAction) input = { event: chipAction };
    else if (rec.reason === 'no_speech') input = { event: 'no_speech' };
    else if (rec.reason === 'live_failed') input = { event: 'live_failed' };
    else input = { event: 'answer', transcript: rec.transcript, languageCode: rec.language, speechSec: rec.speechSec };
    chipAction = null;
    ui.heard(input.transcript);

    const words = (input.transcript || '').trim().split(/\s+/).filter(Boolean).length;
    const reacting = input.event === 'answer' && words >= 3 ? backchannel() : null;
    ui.state('thinking');
    turn = await api('/api/session/turn', { sessionId, ...input });
    await reacting;
  }
}

function showResult(result) {
  ui.state('idle'); ui.card(null); ui.hint('');
  $('chips').hidden = true;
  log('score', `Final placement: level ${result.level} (${result.name}), adjusted score ${result.overall}`, result);
  const bars = Object.entries(result.dims || {}).map(([k, v]) =>
    `<div class="bar"><span>${k}</span><i><b style="width:${(v / 4) * 100}%"></b></i><span>${v.toFixed(1)}</span></div>`).join('');
  const el = $('result');
  el.hidden = false;
  el.innerHTML = `<h2>Level ${result.level} · ${result.name}</h2><p class="lvl">${result.blurb}</p>${bars}
    <details><summary>How we decided</summary><ul>${(result.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('') || '<li>Weighted score across all your answers.</li>'}</ul>
    <pre>${escapeHtml(JSON.stringify(result.answers, null, 1))}</pre></details>`;
}
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// ---------- wiring ----------
$('chips').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  log('app', `Tapped "${e.target.closest('button').textContent.trim()}"`);
  if (act === 'done') return voice.stopListening?.(false); // wait for the final transcript
  chipAction = act;
  voice.stopPlayback?.();
  voice.stopListening?.(true);
});

let started = false;
$('orb').addEventListener('click', async () => {
  if (started) return voice.stopListening?.(false); // tapping the orb while listening = done speaking
  started = true;
  try {
    log('app', 'Session started');
    const cfg = await fetch('/api/config').then((r) => r.json());
    log('app', 'Server config', cfg);
    if (!cfg.ready) throw Object.assign(new Error(cfg.reason || 'Server is not configured'), { userMessage: 'The server has no Sarvam API key. Add SARVAM_API_KEY to .env and restart it.' });

    const params = new URLSearchParams(location.search);
    if (!voice.ctx) await voice.init({ noiseSuppression: params.get('ns') !== '0', autoGainControl: params.get('agc') !== '0' });
    live = new LiveSTT(voice);
    // Send audio from where the learner started talking (+250 ms margin), within the 2 s buffer.
    voice.onBargeIn = (leadMs) => { live.bargeInPrerollMs = Math.min(2000, leadMs + 250); };
    if (!(await live.connect())) {
      throw Object.assign(new Error(`Sarvam Realtime unavailable: ${live.reason}`), { userMessage: "I couldn't connect to the speech service. Check your connection and tap the bubble to try again." });
    }
    log('live', 'Connected: speech-to-text is Sarvam Realtime (streams only while listening)');
    $('convo').textContent = '';
    await run();
  } catch (e) {
    log('error', `Session stopped: ${e.message}`);
    stopCostMeter();
    ui.state('idle');
    ui.bubble('sakhi', e.name === 'NotAllowedError' ? 'I need microphone access to talk with you.' : e.userMessage || `Something went wrong: ${e.message}`);
    live?.close(); live = null;
    started = false;
  }
});

// Greeting bubble on load.
ui.bubble('sakhi', 'Hi! 👋 Tap the bubble and let’s talk.');
