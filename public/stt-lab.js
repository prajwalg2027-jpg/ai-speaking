// STT lab: run one recording through many Sarvam speech-to-text configurations in parallel.
import { int16ToWav } from '/pcm.js';

const RATE = 16000;
const RUPEES_PER_SEC = 30 / 3600; // Sarvam STT: ₹30 per hour of audio
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- every option Sarvam offers (sarvamai SDK 1.1.19) ----------
const MODES = ['', 'codemix', 'transcribe', 'verbatim', 'translit', 'translate'];
const LANGS = ['en-IN', 'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'pa-IN', 'ta-IN', 'te-IN', 'gu-IN', 'as-IN', 'ur-IN',
  'ne-IN', 'kok-IN', 'ks-IN', 'sd-IN', 'sa-IN', 'sat-IN', 'mni-IN', 'brx-IN', 'mai-IN', 'doi-IN'];
const LIVE_FIELDS = [
  ['model', 'Model', 'select', ['saaras:v4', 'saaras:v3-realtime']],
  ['language_code', 'Language', 'select', ['', 'auto', ...LANGS, 'or-IN']],
  ['mode', 'Output mode', 'select', MODES],
  ['stream_type', 'Stream type', 'select', ['', 'balanced', 'fast', 'simulated']],
  ['endpointing', 'Turn detection', 'select', ['', 'vad', 'manual']],
  ['threshold', 'VAD threshold (0–1)', 'number', { min: 0, max: 1, step: 0.05 }],
  ['silence_duration_ms', 'Silence to end turn (ms)', 'number', { min: 0, max: 10000, step: 50 }],
  ['min_speech_duration_ms', 'Min speech (ms)', 'number', { min: 0, max: 10000, step: 10 }],
  ['prefix_padding_ms', 'Prefix padding (ms)', 'number', { min: 0, max: 10000, step: 10 }],
  ['return_timestamps', 'Timestamps', 'select', ['', 'true', 'false']],
  ['encoding', 'Audio encoding', 'select', ['linear16', 'mulaw', 'alaw']],
  ['sample_rate', 'Sample rate', 'select', ['16000', '8000']],
  ['prompt', 'Context prompt', 'text', {}],
  ['keyterms', 'Key terms', 'text', {}],
];
const REST_FIELDS = [
  ['model', 'Model', 'select', ['saaras:v4', 'saaras:v3']],
  ['language_code', 'Language', 'select', ['', 'unknown', ...LANGS, 'od-IN']],
  ['mode', 'Output mode', 'select', MODES],
  ['with_timestamps', 'Timestamps', 'select', ['', 'true', 'false']],
  ['keyterms', 'Key terms (comma-separated, v4 only)', 'text', {}],
];
const PRESETS = {
  'Live · app today (v4, codemix)': { path: 'live', trimmed: false, speed: '1', redetect: true, p: { model: 'saaras:v4', language_code: 'auto', mode: 'codemix', stream_type: 'balanced', endpointing: 'vad', silence_duration_ms: '1200', return_timestamps: 'true', encoding: 'linear16', sample_rate: '16000' } },
  'Live · v3-realtime, fast': { path: 'live', trimmed: false, speed: '1', p: { model: 'saaras:v3-realtime', language_code: 'auto', mode: 'codemix', stream_type: 'fast', endpointing: 'vad', silence_duration_ms: '1200', encoding: 'linear16', sample_rate: '16000' } },
  'Live · trimmed audio (v4)': { path: 'live', trimmed: true, speed: '1', p: { model: 'saaras:v4', language_code: 'auto', mode: 'codemix', endpointing: 'vad', silence_duration_ms: '1200', encoding: 'linear16', sample_rate: '16000' } },
  'Send at once · v4 codemix, trimmed': { path: 'rest', trimmed: true, split: true, p: { model: 'saaras:v4', mode: 'codemix' } },
  'Send at once · v4 verbatim, trimmed': { path: 'rest', trimmed: true, split: true, p: { model: 'saaras:v4', mode: 'verbatim' } },
  'Send at once · v3 codemix, trimmed': { path: 'rest', trimmed: true, split: true, p: { model: 'saaras:v3', mode: 'codemix' } },
  'Send at once · v4 codemix, untrimmed': { path: 'rest', trimmed: false, split: true, p: { model: 'saaras:v4', mode: 'codemix' } },
  'Blank live': { path: 'live', trimmed: false, speed: '1', p: { model: 'saaras:v4', encoding: 'linear16', sample_rate: '16000' } },
  'Blank send at once': { path: 'rest', trimmed: false, split: true, p: { model: 'saaras:v4' } },
};

// ---------- state ----------
let ctx = null, recorder = null;
let original = null;   // Float32Array @16 kHz
let analysis = null;   // speech segments etc. on the original
let trimmed = null;    // { audio, spans } after trimming
let cards = [];        // { id, name, path, trimmed, split, speed, p, el, result }
let nextId = 1;

// ---------- audio in ----------
async function resample(f32, from, to) {
  if (from === to) return f32;
  const oc = new OfflineAudioContext(1, Math.ceil((f32.length * to) / from), to);
  const buf = oc.createBuffer(1, f32.length, from); buf.copyToChannel(f32, 0);
  const src = oc.createBufferSource(); src.buffer = buf; src.connect(oc.destination); src.start();
  return (await oc.startRendering()).getChannelData(0);
}

$('rec').addEventListener('click', async () => {
  if (recorder) return stopRecording();
  ctx ||= new AudioContext(); await ctx.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: $('aec').checked, noiseSuppression: $('ns').checked, autoGainControl: $('agc').checked, channelCount: 1 } });
  } catch (e) { $('audioStats').textContent = `Microphone error: ${e.message}`; return; }
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(2048, 1, 1), chunks = [];
  const t0 = performance.now();
  proc.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); $('audioStats').textContent = `Recording… ${((performance.now() - t0) / 1000).toFixed(1)} s`; };
  src.connect(proc); proc.connect(ctx.destination);
  const st = stream.getAudioTracks()[0].getSettings();
  recorder = { stream, src, proc, chunks, rate: ctx.sampleRate, settings: { echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression, autoGainControl: st.autoGainControl } };
  $('rec').textContent = '■ Stop'; $('rec').classList.add('rec');
});

async function stopRecording() {
  const r = recorder; recorder = null;
  r.proc.disconnect(); r.src.disconnect(); r.stream.getTracks().forEach((t) => t.stop());
  $('rec').textContent = '● Record again'; $('rec').classList.remove('rec');
  const all = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of r.chunks) { all.set(c, o); o += c.length; }
  await setAudio(await resample(all, r.rate, RATE), { source: 'mic', mic: r.settings });
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  ctx ||= new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await f.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
    await setAudio(await resample(mono, buf.sampleRate, RATE), { source: `file: ${f.name}` });
  } catch (err) { $('audioStats').textContent = `Couldn't read that file: ${err.message}`; }
});

let audioMeta = {};
async function setAudio(f32, meta) {
  original = f32; audioMeta = meta;
  refreshTrim();
  $('playOrig').disabled = false; $('playTrim').disabled = false; $('run').disabled = false;
}

// ---------- analysis and trimming ----------
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);

function analyze(f32, thrDb) {
  const win = RATE / 50; // 20 ms
  const levels = [];
  for (let k = 0; k + win <= f32.length; k += win) { let s = 0; for (let j = k; j < k + win; j++) s += f32[j] * f32[j]; levels.push(db(Math.sqrt(s / win))); }
  const sorted = [...levels].sort((a, b) => a - b);
  const noiseDb = sorted[Math.floor(sorted.length * 0.1)] ?? -120;
  const thr = Number.isFinite(thrDb) ? thrDb : Math.max(noiseDb + 12, -60);
  const speech = levels.map((l) => l > thr);
  // Fill gaps under 200 ms (they're inside words), drop blips under 60 ms.
  for (let i = 0; i < speech.length;) {
    if (speech[i]) { i++; continue; }
    let j = i; while (j < speech.length && !speech[j]) j++;
    if (i > 0 && j < speech.length && j - i < 10) for (let k = i; k < j; k++) speech[k] = true;
    i = j;
  }
  const segments = [];
  for (let i = 0; i < speech.length;) {
    if (!speech[i]) { i++; continue; }
    let j = i; while (j < speech.length && speech[j]) j++;
    if (j - i >= 3) segments.push([i * win, Math.min(f32.length, j * win)]);
    i = j;
  }
  const pauses = segments.slice(1).map((s, i) => (s[0] - segments[i][1]) / RATE * 1000);
  return {
    seconds: f32.length / RATE, noiseDb, thrDb: thr, segments,
    speechSec: segments.reduce((n, [a, b]) => n + (b - a), 0) / RATE,
    pauses: pauses.filter((p) => p >= 300).length, longestPauseMs: Math.round(Math.max(0, ...pauses)),
    lastSpeechSec: segments.length ? segments.at(-1)[1] / RATE : f32.length / RATE,
  };
}

/** Cut edges and shorten long pauses. Returns the new audio and its speech spans (for splitting). */
function trim(f32, an, { trimEdges, maxPauseMs, padMs }) {
  if (!an.segments.length) return { audio: f32, spans: [[0, f32.length]] };
  const pad = Math.round((padMs / 1000) * RATE), maxGap = Math.round((maxPauseMs / 1000) * RATE);
  const spans = [];
  for (const [a, b] of an.segments) {
    const s = [Math.max(0, a - pad), Math.min(f32.length, b + pad)];
    if (spans.length && s[0] <= spans.at(-1)[1]) spans.at(-1)[1] = s[1]; else spans.push(s);
  }
  const parts = [], outSpans = [];
  let len = 0;
  const push = (from, to) => { parts.push(f32.subarray(from, to)); len += to - from; };
  if (!trimEdges) push(0, spans[0][0]);
  spans.forEach(([a, b], i) => {
    const start = len; push(a, b); outSpans.push([start, len]);
    const next = spans[i + 1];
    if (!next) return;
    const gap = next[0] - b;
    if (gap <= maxGap) push(b, next[0]);
    else { push(b, b + maxGap / 2); push(next[0] - maxGap / 2, next[0]); } // keep the pause's edges, drop its middle
  });
  if (!trimEdges) push(spans.at(-1)[1], f32.length);
  const audio = new Float32Array(len);
  let o = 0; for (const p of parts) { audio.set(p, o); o += p.length; }
  return { audio, spans: outSpans };
}

function refreshTrim() {
  if (!original) return;
  const thr = $('thr').value === '' ? NaN : Number($('thr').value);
  analysis = analyze(original, thr);
  trimmed = trim(original, analysis, { trimEdges: $('trimEdges').checked, maxPauseMs: Number($('maxPause').value), padMs: Number($('pad').value) });
  const t = trimmed.audio.length / RATE;
  $('audioStats').textContent = `${audioMeta.source}${audioMeta.mic ? ` (mic: echo ${audioMeta.mic.echoCancellation}, noise suppression ${audioMeta.mic.noiseSuppression}, auto volume ${audioMeta.mic.autoGainControl})` : ''} · ${analysis.seconds.toFixed(1)} s · speech ${analysis.speechSec.toFixed(1)} s · ${analysis.pauses} pauses ≥ 0.3 s · longest pause ${(analysis.longestPauseMs / 1000).toFixed(1)} s · noise ${analysis.noiseDb.toFixed(0)} dBFS, threshold ${analysis.thrDb.toFixed(0)} dBFS`;
  $('trimStats').textContent = `Trimmed: ${analysis.seconds.toFixed(1)} s → ${t.toFixed(1)} s (${Math.round((1 - t / analysis.seconds) * 100)}% shorter)${t > 28 ? ' · over 28 s: "send at once" will split it at pauses' : ''}`;
}
['trimEdges', 'maxPause', 'pad', 'thr'].forEach((id) => $(id).addEventListener('input', refreshTrim));

function play(f32) {
  ctx ||= new AudioContext();
  const b = ctx.createBuffer(1, f32.length, RATE); b.copyToChannel(f32, 0);
  const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
}
$('playOrig').addEventListener('click', () => original && play(original));
$('playTrim').addEventListener('click', () => trimmed && play(trimmed.audio));
$('preset').addEventListener('change', (e) => { if (e.target.value) $('expected').value = e.target.value; });

// ---------- encoders (G.711 per the ITU reference) ----------
const toInt16 = (f32) => { const o = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) { const x = Math.max(-1, Math.min(1, f32[i])); o[i] = x < 0 ? x * 0x8000 : x * 0x7fff; } return o; };
const seg = (v, table) => { for (let i = 0; i < table.length; i++) if (v <= table[i]) return i; return table.length; };
const U_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff], A_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
function mulaw(s) { let v = s >> 2, mask = 0xff; if (v < 0) { v = -v; mask = 0x7f; } if (v > 8159) v = 8159; v += 0x84 >> 2; const g = seg(v, U_END); return g >= 8 ? 0x7f ^ mask : ((g << 4) | ((v >> (g + 1)) & 0xf)) ^ mask; }
function alaw(s) { let v = s >> 3, mask = 0xd5; if (v < 0) { mask = 0x55; v = -v - 1; } const g = seg(v, A_END); if (g >= 8) return 0x7f ^ mask; let a = g << 4; a |= g < 2 ? (v >> 1) & 0xf : (v >> g) & 0xf; return a ^ mask; }
function encode(f32, enc) {
  const pcm = toInt16(f32);
  if (enc === 'linear16') return new Uint8Array(pcm.buffer);
  const out = new Uint8Array(pcm.length), fn = enc === 'mulaw' ? mulaw : alaw;
  for (let i = 0; i < pcm.length; i++) out[i] = fn(pcm[i]);
  return out;
}

// ---------- configuration cards ----------
for (const name of Object.keys(PRESETS)) $('addPreset').add(new Option(name, name));
$('add').addEventListener('click', () => addCard($('addPreset').value));

function addCard(presetName, overrides = {}) {
  const pr = structuredClone(PRESETS[presetName]);
  const card = { id: nextId++, name: presetName, path: pr.path, trimmed: pr.trimmed, split: pr.split ?? true, speed: pr.speed ?? '1', redetect: pr.redetect ?? false, p: pr.p, ...overrides };
  cards.push(card);
  renderCard(card);
}

function renderCard(card) {
  const el = card.el || document.createElement('article');
  el.className = `card ${card.path}`;
  const fields = card.path === 'live' ? LIVE_FIELDS : REST_FIELDS;
  el.innerHTML = `
    <div class="head"><span class="pill ${card.path}">${card.path === 'live' ? 'LIVE' : 'AT ONCE'}</span>
      <input type="text" data-k="name" value="${esc(card.name)}" aria-label="Configuration name"></div>
    <div class="grid">
      <label class="f">Path<select data-k="path"><option value="live">Live (stream over WebSocket)</option><option value="rest">Send at once (upload)</option></select></label>
      <label class="c"><input type="checkbox" data-k="trimmed"> Use trimmed audio</label>
      ${card.path === 'live'
        ? `<label class="f">Send speed<select data-k="speed"><option value="1">1× (real time)</option><option value="2">2×</option><option value="4">4×</option><option value="0">As fast as possible</option></select></label>
           <label class="c"><input type="checkbox" data-k="redetect"> Re-detect language after each utterance (as the app does)</label>`
        : `<label class="c"><input type="checkbox" data-k="split"> Split audio over 28 s at pauses</label>`}
    </div>
    <details open><summary>Sarvam settings</summary><div class="grid" style="margin-top:8px">
      ${fields.map(([k, label, type, opts]) => `<label class="f">${label} <code>${k}</code>${type === 'select'
        ? `<select data-p="${k}">${opts.map((o) => `<option value="${o}">${o || 'default'}</option>`).join('')}</select>`
        : `<input type="${type}" data-p="${k}" placeholder="default" ${type === 'number' ? `min="${opts.min}" max="${opts.max}" step="${opts.step}"` : ''}>`}</label>`).join('')}
    </div></details>
    <div class="row"><button type="button" data-a="dup">Duplicate</button><button type="button" data-a="del">Remove</button></div>
    <div class="result" hidden></div>`;
  el.querySelector('[data-k=path]').value = card.path;
  el.querySelector('[data-k=trimmed]').checked = card.trimmed;
  if (card.path === 'live') { el.querySelector('[data-k=speed]').value = card.speed; el.querySelector('[data-k=redetect]').checked = card.redetect; }
  else el.querySelector('[data-k=split]').checked = card.split;
  for (const inp of el.querySelectorAll('[data-p]')) inp.value = card.p[inp.dataset.p] ?? '';
  el.oninput = (e) => {
    const t = e.target;
    if (t.dataset.k === 'path') { card.path = t.value; card.p = { model: t.value === 'live' ? 'saaras:v4' : 'saaras:v4', ...(t.value === 'live' ? { encoding: 'linear16', sample_rate: '16000' } : {}) }; return renderCard(card); }
    if (t.dataset.k) card[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.p) card.p[t.dataset.p] = t.value;
  };
  el.querySelector('[data-a=dup]').onclick = () => addCard(Object.keys(PRESETS)[0], { name: `${card.name} (copy)`, path: card.path, trimmed: card.trimmed, split: card.split, speed: card.speed, redetect: card.redetect, p: { ...card.p } });
  el.querySelector('[data-a=del]').onclick = () => { cards = cards.filter((c) => c !== card); el.remove(); };
  if (!card.el) { card.el = el; $('cards').append(el); }
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- running ----------
$('run').addEventListener('click', async () => {
  if (!original) return;
  $('run').disabled = true;
  await Promise.all(cards.map((c) => runCard(c)));
  $('run').disabled = false;
  renderSummary();
});

async function runCard(card) {
  const box = card.el.querySelector('.result');
  box.hidden = false; box.innerHTML = '<span class="stats">Running…</span>';
  const audio = card.trimmed ? trimmed.audio : original;
  const spans = card.trimmed ? trimmed.spans : analysis.segments;
  try {
    card.result = card.path === 'live' ? await runLive(card, audio) : await runRest(card, audio, spans);
  } catch (e) {
    card.result = { error: e.message };
  }
  const exp = $('expected').value.trim();
  if (exp && card.result.transcript != null) {
    const c = await fetch('/api/lab/compare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: exp, heard: card.result.transcript }) }).then((r) => r.json());
    card.result.accuracy = c.accuracy; card.result.compared = c.compared;
  }
  showResult(card);
}

async function runRest(card, audio, spans) {
  const chunks = [];
  const maxLen = 28 * RATE;
  if (audio.length <= maxLen || !card.split) chunks.push(audio);
  else {
    // Split at the middle of pauses so no piece is over 28 s.
    let start = 0;
    for (let i = 0; i < spans.length; i++) {
      if (spans[i][1] - start <= maxLen) continue;
      const cut = i > 0 && spans[i - 1][1] > start ? Math.round((spans[i - 1][1] + spans[i][0]) / 2) : start + maxLen;
      chunks.push(audio.subarray(start, cut)); start = cut;
      while (spans[i][1] - start > maxLen) { chunks.push(audio.subarray(start, start + maxLen)); start += maxLen; }
    }
    chunks.push(audio.subarray(start));
  }
  if (chunks.some((c) => c.length > 30 * RATE)) throw new Error('Audio is over Sarvam\'s 30 s upload limit. Turn on "Split audio" or trim it.');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(card.p)) {
    if (v === '' || v == null) continue;
    qs.set(k, k === 'keyterms' ? JSON.stringify(v.split(',').map((t) => t.trim()).filter(Boolean)) : v);
  }
  const t0 = performance.now();
  const parts = await Promise.all(chunks.map(async (c) => {
    const res = await fetch(`/api/lab/transcribe?${qs}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: int16ToWav(toInt16(c), RATE) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.statusText);
    return j;
  }));
  const ms = Math.round(performance.now() - t0);
  const billedSec = chunks.reduce((n, c) => n + Math.ceil(c.length / RATE), 0); // billed per second, rounded up per request
  return {
    transcript: parts.map((p) => p.transcript).join(' ').trim(), language: parts[0]?.languageCode, confidence: parts[0]?.languageProbability,
    requests: parts.length, processingMs: ms, waitAfterLastWordMs: Number($('eot').value) + ms,
    sentSec: audio.length / RATE, billedSec, raw: parts,
  };
}

async function runLive(card, audio) {
  const p = card.p;
  const rate = Number(p.sample_rate || RATE);
  const src = rate === RATE ? audio : await resample(audio, RATE, rate);
  const enc = p.encoding || 'linear16';
  const bytes = encode(src, enc), bps = enc === 'linear16' ? 2 : 1;
  const chunk = (rate / 10) * bps; // 100 ms
  const an = analyze(audio, $('thr').value === '' ? NaN : Number($('thr').value));
  const lastSpeechByte = Math.floor(an.lastSpeechSec * rate) * bps;
  const speed = Number(card.speed);
  const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== '' && v != null));
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/lab/live?${qs}`);
  ws.binaryType = 'arraybuffer';
  const r = { finals: [], partials: 0, events: [], notes: [], errors: [] };
  let t0 = 0, lastSpeechAt = null;
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { r.errors.push('timed out waiting for Sarvam to finish'); resolve(); ws.close(); }, 60_000 + (bytes.length / bps / rate) * 1000);
    ws.onmessage = async (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'log') return r.notes.push(e.msg + (e.data ? ` ${JSON.stringify(e.data)}` : ''));
      if (e.type === 'unavailable') { r.errors.push(e.reason); clearTimeout(timer); return resolve(); }
      if (e.type === 'ready') return stream();
      if (e.type !== 'sarvam') return;
      const ev = e.event, at = Math.round(performance.now() - t0);
      r.events.push({ at, ...ev, ...(ev.audio ? { audio: '…' } : {}) });
      if (ev.event === 'session.begin') r.config = ev.config;
      if (ev.event === 'transcript.partial') { r.partials++; r.firstPartialMs ??= at; }
      if (ev.event === 'transcript.final') {
        r.finals.push(ev); r.lastFinalAt = performance.now();
        // Without this, Sarvam keeps the first detected language for the rest of the session.
        if (card.redetect) ws.send(JSON.stringify({ type: 'sarvam', event: { event: 'config.update', language_code: p.language_code || 'auto' } }));
      }
      if (ev.event === 'error') r.errors.push(`${ev.code}: ${ev.message}`);
      if (ev.event === 'session.end') { r.sessionEnd = ev; clearTimeout(timer); resolve(); ws.close(); }
    };
    ws.onclose = () => { clearTimeout(timer); resolve(); };
  });
  async function stream() {
    t0 = performance.now();
    if (p.endpointing === 'manual') ws.send(JSON.stringify({ type: 'sarvam', event: { event: 'speech_start' } }));
    for (let o = 0; o < bytes.length; o += chunk) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(bytes.slice(o, o + chunk).buffer);
      if (lastSpeechAt == null && o + chunk >= lastSpeechByte) lastSpeechAt = performance.now();
      await sleep(speed > 0 ? 100 / speed : 0);
    }
    if (p.endpointing === 'manual') ws.send(JSON.stringify({ type: 'sarvam', event: { event: 'speech_end' } }));
    ws.send(JSON.stringify({ type: 'sarvam', event: { event: 'end' } })); // finalize and close
  }
  await done;
  if (r.errors.length && !r.finals.length) throw new Error(r.errors.join('; '));
  const sentSec = bytes.length / bps / rate;
  return {
    transcript: r.finals.map((f) => f.text).join(' ').trim(), language: r.finals.at(-1)?.language, confidence: r.finals.at(-1)?.language_confidence,
    utterances: r.finals.length, perUtterance: r.finals.map((f) => ({ text: f.text, language: f.language, confidence: f.language_confidence })),
    partials: r.partials, firstPartialMs: r.firstPartialMs,
    waitAfterLastWordMs: r.lastFinalAt && lastSpeechAt ? Math.round(r.lastFinalAt - lastSpeechAt) : null, speed,
    sentSec, billedSec: r.sessionEnd?.audio_duration_s ?? sentSec, billedFromSarvam: r.sessionEnd?.audio_duration_s != null,
    sarvamConfig: r.config, errors: r.errors, notes: r.notes, raw: r.events,
  };
}

function showResult(card) {
  const r = card.result, box = card.el.querySelector('.result');
  if (r.error) { box.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
  const m = [
    ['Accuracy', r.accuracy != null ? `${Math.round(r.accuracy * 100)}%` : '–'],
    ['Language', `${r.language ?? '–'}${r.confidence != null ? ` (${Number(r.confidence).toFixed(2)})` : ''}`],
    ['Wait after last word', r.waitAfterLastWordMs != null ? `${(r.waitAfterLastWordMs / 1000).toFixed(2)} s${card.path === 'live' && r.speed !== 1 ? ` (at ${r.speed || 'max'}× speed: not realistic)` : card.path === 'rest' ? ` (${$('eot').value} ms on-device wait + ${r.processingMs} ms)` : ''}` : '–'],
    ...(card.path === 'live' ? [['First partial', r.firstPartialMs != null ? `${r.firstPartialMs} ms after streaming began` : 'none'], ['Utterances', r.perUtterance.map((u) => `${u.language ?? '?'}: ${u.text}`).join(' ‖ ') || r.utterances]] : [['Requests', r.requests]]),
    ['Audio sent', `${r.sentSec.toFixed(1)} s`],
    ['Billed', `${Number(r.billedSec).toFixed(1)} s${r.billedFromSarvam ? ' (reported by Sarvam)' : ''} · ₹${(r.billedSec * RUPEES_PER_SEC).toFixed(3)}`],
  ];
  box.innerHTML = `<div class="tx">“${esc(r.transcript || '(nothing)')}”</div>
    ${r.compared && r.accuracy < 1 ? `<div class="stats">compared: “${esc(r.compared.expected)}” vs “${esc(r.compared.heard)}”</div>` : ''}
    ${r.errors?.length ? `<div class="err">${esc(r.errors.join('; '))}</div>` : ''}
    <dl class="metrics">${m.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <details><summary>Raw ${card.path === 'live' ? 'events and settings Sarvam applied' : 'response'}</summary><pre>${esc(JSON.stringify(card.path === 'live' ? { sarvamConfig: r.sarvamConfig, notes: r.notes, events: r.raw } : r.raw, null, 2))}</pre></details>`;
}

function renderSummary() {
  const rows = cards.filter((c) => c.result);
  $('summaryBox').hidden = !rows.length;
  const perHour = (r) => (analysis.seconds ? (r.billedSec / analysis.seconds) * 30 : 0);
  $('summary').innerHTML = `<thead><tr><th>Configuration</th><th>Transcript</th><th>Accuracy</th><th>Wait after last word</th><th>Billed</th><th>₹ per hour of speaking*</th></tr></thead><tbody>${rows.map((c) => {
    const r = c.result;
    if (r.error) return `<tr><td><span class="pill ${c.path}">${c.path === 'live' ? 'LIVE' : 'AT ONCE'}</span> ${esc(c.name)}</td><td colspan="5" style="color:var(--bad)">${esc(r.error)}</td></tr>`;
    return `<tr><td><span class="pill ${c.path}">${c.path === 'live' ? 'LIVE' : 'AT ONCE'}</span> ${esc(c.name)}</td><td>${esc(r.transcript)}</td><td>${r.accuracy != null ? Math.round(r.accuracy * 100) + '%' : '–'}</td><td>${r.waitAfterLastWordMs != null ? (r.waitAfterLastWordMs / 1000).toFixed(2) + ' s' : '–'}</td><td>${Number(r.billedSec).toFixed(1)} s of ${analysis.seconds.toFixed(1)} s</td><td>₹${perHour(r).toFixed(2)}</td></tr>`;
  }).join('')}</tbody>`;
}

$('copy').addEventListener('click', async (e) => {
  const payload = {
    test: 'stt lab', at: new Date().toISOString(), userAgent: navigator.userAgent, audio: { ...audioMeta, seconds: analysis?.seconds, speechSec: analysis?.speechSec, pauses: analysis?.pauses, longestPauseMs: analysis?.longestPauseMs, trimmedSec: trimmed ? trimmed.audio.length / RATE : null },
    trim: { trimEdges: $('trimEdges').checked, maxPauseMs: Number($('maxPause').value), padMs: Number($('pad').value), thresholdDb: $('thr').value || 'auto', endOfTurnMs: Number($('eot').value) },
    expected: $('expected').value,
    configs: cards.map((c) => ({ name: c.name, path: c.path, trimmed: c.trimmed, split: c.split, speed: c.speed, params: c.p, result: c.result && { ...c.result, raw: undefined, notes: undefined } })),
  };
  const btn = e.currentTarget, txt = JSON.stringify(payload, null, 2);
  try { await navigator.clipboard.writeText(txt); btn.textContent = 'Copied'; }
  catch { const ta = document.createElement('textarea'); ta.value = txt; document.body.append(ta); ta.select(); try { document.execCommand('copy'); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; } ta.remove(); }
  setTimeout(() => (btn.textContent = 'Copy results'), 1500);
});

// Start with a useful comparison: the app's live setup vs sending trimmed audio at once.
addCard('Live · app today (v4, codemix)');
addCard('Send at once · v4 codemix, trimmed');
addCard('Send at once · v4 verbatim, trimmed');
