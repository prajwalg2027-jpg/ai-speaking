// Placement conversation: a small state machine over the shared question bank.
import { QUESTIONS, ACKS, PHRASES, LEVELS, variantFor } from '/shared/assessment.js';
import { Voice } from '/audio.js';
import { LiveSTT } from '/live.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const ui = {
  state: (s) => (app.dataset.state = s),
  bot: (t) => ($('botLine').textContent = t),
  you: (t) => ($('youLine').textContent = t ? `“${t}”` : ''),
  hint: (t) => ($('hint').textContent = t || ''),
  card: (text, kind) => {
    const c = $('card');
    c.hidden = !text; c.textContent = text || ''; c.className = `card ${kind || ''}`;
  },
  progress: (i) => ($('progress').textContent = i == null ? '' : `${i + 1} / ${QUESTIONS.length}`),
};

const voice = new Voice((lvl) => document.documentElement.style.setProperty('--lvl', lvl.toFixed(3)));
let demo = false;
let live = null; // LiveSTT when Sarvam realtime is available, else null (REST fallback)
let chipAction = null; // set by chip taps, consumed by the turn loop

// ---------- speaking ----------
async function say(text, { lang = 'en-IN', pace = 1 } = {}) {
  ui.state('speaking'); ui.bot(text);
  if (demo) return speakBrowser(text, lang, pace);
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang, pace }) }).then((r) => r.json());
    if (r.audio) return await voice.play(r.audio);
  } catch (e) { console.warn('TTS failed, using browser voice', e); }
  return speakBrowser(text, lang, pace);
}
function speakBrowser(text, lang, pace) {
  return new Promise((res) => {
    if (!('speechSynthesis' in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang; u.rate = pace; u.onend = u.onerror = res;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  });
}

// ---------- listening ----------
async function listen(silenceMs) {
  ui.state('listening'); ui.hint('Listening…');
  if (live?.alive) {
    const r = await live.listen({ silenceMs, onNudge: () => ui.hint(PHRASES.nudge), onPartial: (t) => ui.you(t) });
    if (r.reason !== 'live_failed') { ui.hint(''); return r; }
    console.warn('Realtime STT dropped; falling back to REST for the rest of the session');
    live = null; voice.localBargeIn = true;
  }
  return listenRest(silenceMs);
}

async function listenRest(silenceMs) {
  let rec = null, demoText = '';
  if (demo && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
    rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    rec.lang = 'en-IN'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = (e) => { demoText = [...e.results].map((r) => r[0].transcript).join(' '); ui.you(demoText); };
    rec.start();
  }
  const r = await voice.listen({ silenceMs, onNudge: () => ui.hint(PHRASES.nudge) });
  if (rec) { rec.stop(); await new Promise((ok) => setTimeout(ok, 400)); }
  ui.hint('');
  return { ...r, demoText };
}

async function submitTurn(qIndex, level, rec, prior) {
  ui.state('thinking'); ui.hint('…');
  const qs = new URLSearchParams({ q: qIndex, level, speechSec: rec.speechSec.toFixed(2) });
  if (prior) qs.set('prior', prior);
  // Realtime and demo answers are already transcribed; REST answers upload the WAV for Saaras.
  const text = rec.live ? { transcript: rec.transcript, languageCode: rec.language } : demo ? { transcript: rec.demoText || '' } : null;
  const res = await fetch(`/api/turn?${qs}`, text
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(text) }
    : { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: rec.wav });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// ---------- one question, with the clarification ladder ----------
async function askQuestion(qIndex, level) {
  const q = QUESTIONS[qIndex];
  const v = variantFor(q, level);
  ui.progress(qIndex); ui.you('');
  ui.card(q.kind === 'open' && qIndex === 0 ? null : v.screen, q.kind === 'read' ? 'read' : '');

  let confusions = 0, unheard = 0, neededHindi = false, prior = '';
  let prompt = { text: v.say, lang: 'en-IN', pace: 1 };

  for (;;) {
    chipAction = null;
    live?.beginPrompt();
    await say(prompt.text, prompt);
    // A chip tapped while the bot was talking skips straight to handling it.
    const rec = chipAction ? { reason: 'manual' } : await listen(q.silenceMs);
    let intent = chipAction; chipAction = null;

    let r = null;
    if (!intent) {
      if (rec.reason === 'no_speech') intent = confusions === 0 ? 'in_hindi' : 'dont_know'; // 12s silence
      else {
        try { r = await submitTurn(qIndex, level, rec, prior); }
        catch (e) { console.error(e); r = { action: 'didnt_hear' }; }
        ui.you(r.transcript);
        if (r.action === 'clarify') intent = r.intent;
      }
    }

    if (intent === 'skip' || intent === 'dont_know' || (intent && confusions >= 2)) {
      await say(PHRASES.moveOn);
      return { questionId: q.id, kind: q.kind, variantLevel: level, skipped: true, neededHindi, features: {}, scores: zeroScores() };
    }
    if (intent) {
      confusions++;
      if (intent === 'in_hindi' || confusions === 2) {
        neededHindi = true;
        // Say the simple English then the Hindi as two clips, so each uses the right voice language.
        await say(v.simple || v.say, { pace: 0.85 });
        prompt = { text: v.hindi, lang: 'hi-IN', pace: 0.9 };
      } else {
        prompt = { text: v.say, lang: 'en-IN', pace: 0.8 }; // repeat / slower
      }
      continue;
    }
    if (r.action === 'didnt_hear') {
      if (++unheard > 2) { await say(PHRASES.moveOn); return { questionId: q.id, kind: q.kind, variantLevel: level, skipped: true, neededHindi, features: {}, scores: zeroScores() }; }
      prompt = { text: PHRASES.didntHear, lang: 'en-IN', pace: 0.95 };
      continue;
    }
    if (r.action === 'cut_off') {
      prior = r.transcript;
      prompt = { text: PHRASES.cutOff, lang: 'en-IN', pace: 1 };
      continue;
    }
    // scored
    return { questionId: q.id, kind: q.kind, variantLevel: level, skipped: false, neededHindi, ...r };
  }
}

const zeroScores = () => ({ comprehension: 0, vocabulary: 0, grammar: 0, fluency: 0, pronunciation: 0, coherence: 0 });

// ---------- whole placement ----------
async function run() {
  $('chips').hidden = false;
  const answers = [];
  let level = 2;

  for (let i = 0; i < QUESTIONS.length; i++) {
    let a = await askQuestion(i, level);

    if (QUESTIONS[i].id === 'q1_intro') {
      level = a.skipped ? 1 : a.provisionalLevel ?? 2;
      await say(a.ack || ACKS[0]);
    } else if (QUESTIONS[i].id === 'q3_read' && !a.skipped && a.features.readAccuracy >= 0.95 && level < 4) {
      // Ceiling probe: strong reader gets the next level's sentence.
      await say("Great reading! Here's a slightly harder one.");
      const harder = await askQuestion(i, level + 1);
      if (!harder.skipped && harder.features.readAccuracy >= 0.8) { a = harder; level += 1; }
    } else if (i < QUESTIONS.length - 1) {
      await say(ACKS[(i % (ACKS.length - 1)) + 1]);
    }
    answers.push(a);
  }

  $('chips').hidden = true;
  await say(PHRASES.done);
  ui.state('thinking');
  const result = await fetch('/api/final', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) }).then((r) => r.json());
  showResult(result, answers);
}

function showResult(result, answers) {
  const L = LEVELS[result.level];
  ui.state('idle'); ui.card(null); ui.you(''); ui.hint(''); ui.progress(null);
  ui.bot(`You're a ${L.name} speaker 🎉`);
  const bars = Object.entries(result.dims || {}).map(([k, v]) =>
    `<div class="bar"><span>${k}</span><i><b style="width:${(v / 4) * 100}%"></b></i><span>${v.toFixed(1)}</span></div>`).join('');
  const el = $('result');
  el.hidden = false;
  el.innerHTML = `<h2>Level ${result.level} · ${L.name}</h2><p class="lvl">${L.blurb}</p>${bars}
    <details><summary>How we decided</summary><ul>${(result.reasons || []).map((r) => `<li>${r}</li>`).join('') || '<li>Weighted score across all four answers.</li>'}</ul>
    <pre>${escapeHtml(JSON.stringify(answers.map((a) => ({ q: a.questionId, level: a.variantLevel, transcript: a.transcript, hindi: a.neededHindi })), null, 1))}</pre></details>`;
  say(`You're a ${L.name} speaker! ${L.blurb}`);
}
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// ---------- wiring ----------
$('chips').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  if (act === 'done') return voice.stopListening?.(false); // wait for the final transcript
  chipAction = act;
  voice.stopPlayback?.(); speechSynthesis?.cancel();
  voice.stopListening?.(true);
});

let started = false;
$('orb').addEventListener('click', async () => {
  if (started) return voice.stopListening?.(false); // tapping the orb while listening = done speaking
  started = true;
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    demo = cfg.demo;
    await voice.init();
    if (demo) ui.hint('Demo mode: browser speech (add SARVAM_API_KEY for Sarvam)');
    if (cfg.realtime) {
      const candidate = new LiveSTT(voice);
      if (await candidate.connect()) {
        live = candidate;
        voice.localBargeIn = false;
        live.onBargeIn = () => { voice.stopPlayback?.(); speechSynthesis?.cancel(); };
        document.documentElement.dataset.stt = 'realtime';
      } else {
        console.info(`Realtime STT unavailable (${candidate.reason}); using REST speech-to-text`);
        document.documentElement.dataset.stt = 'rest';
      }
    }
    await run();
  } catch (e) {
    console.error(e);
    ui.state('idle');
    ui.bot(e.name === 'NotAllowedError' ? 'I need microphone access to talk with you.' : `Something went wrong: ${e.message}`);
    started = false;
  }
});

// Greeting bubble on load.
ui.bot('Hi! 👋 Tap the bubble and let’s talk.');
