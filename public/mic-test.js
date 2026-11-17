// Mic test: record each sentence with the phone's audio processing ON and OFF, transcribe every take with
// Saaras v4 (same model and mode as the app), and compare accuracy and audio levels.
import { createResampler, int16ToWav } from '/pcm.js';

const SENTENCES = [
  { text: 'Every morning I take the bus to work, and it is always crowded.' },
  { text: "Vikram's van went west on Wednesday with seven heavy bags.", note: 'Tests v / w sounds' },
  { text: 'I paid two hundred and fifty rupees for three thick notebooks.', note: 'Numbers and "th"' },
  { text: 'Although the weather was terrible, we decided to continue our journey.' },
  { text: 'कल मैं market गया था and I bought fresh vegetables.', note: 'Hinglish: read it naturally' },
  { text: 'My sister is a nurse in Chennai.', note: 'Say this one softly, almost whispering' },
];
const MODES = {
  on: { label: 'ON', constraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
  off: { label: 'OFF', constraints: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } },
  raw: { label: 'RAW', constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
};
const MAX_SEC = 25; // Sarvam's REST transcription accepts up to 30 s

const $ = (id) => document.getElementById(id);
const results = []; // { sentence, mode, ...metrics, transcript, accuracy }
let ctx = null, active = null;

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

function modesFor(i) {
  const base = i % 2 === 0 ? ['on', 'off'] : ['off', 'on'];
  return $('raw').checked ? [...base, 'raw'] : base;
}

function render() {
  $('items').innerHTML = '';
  SENTENCES.forEach((s, i) => {
    const el = document.createElement('section');
    el.className = 'item';
    el.innerHTML = `<div class="say">${i + 1}. ${s.text}</div>${s.note ? `<div class="how">${s.note}</div>` : ''}<div class="takes"></div>`;
    for (const m of modesFor(i)) {
      const take = document.createElement('div');
      take.className = 'take';
      take.innerHTML = `<span class="tag ${m}">${MODES[m].label}</span>
        <div class="row"><button type="button" class="go">Record</button><div class="meter"><b></b></div><span class="t"></span></div>
        <div class="res"></div>`;
      take.querySelector('.go').addEventListener('click', () => toggle(take, i, m));
      el.querySelector('.takes').append(take);
    }
    $('items').append(el);
  });
}

async function toggle(take, i, mode) {
  if (active?.take === take) return stop();
  if (active) await stop();
  ctx ||= new AudioContext();
  await ctx.resume();
  const btn = take.querySelector('.go');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MODES[mode].constraints, channelCount: 1 } });
  } catch (e) {
    take.querySelector('.res').textContent = `Microphone error: ${e.message}`;
    return;
  }
  const applied = stream.getAudioTracks()[0].getSettings();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const chunks = [];
  const meter = take.querySelector('.meter b'), timer = take.querySelector('.t');
  const t0 = performance.now();
  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(d);
    let s = 0; for (const x of d) s += x * x;
    meter.style.width = `${Math.min(100, Math.sqrt(s / d.length) * 400)}%`;
    const sec = (performance.now() - t0) / 1000;
    timer.textContent = `${sec.toFixed(1)} s`;
    if (sec > MAX_SEC) stop();
  };
  src.connect(proc); proc.connect(ctx.destination);
  btn.textContent = 'Stop'; btn.classList.add('rec');
  active = { take, i, mode, stream, src, proc, chunks, applied, rate: ctx.sampleRate };
}

async function stop() {
  const a = active; if (!a) return;
  active = null;
  a.proc.disconnect(); a.src.disconnect(); a.stream.getTracks().forEach((t) => t.stop());
  const btn = a.take.querySelector('.go');
  btn.textContent = 'Record again'; btn.classList.remove('rec');
  a.take.querySelector('.meter b').style.width = '0';
  const res = a.take.querySelector('.res');
  res.textContent = 'Transcribing…';

  // Audio measurements on the raw capture (20 ms windows).
  const all = new Float32Array(a.chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of a.chunks) { all.set(c, o); o += c.length; }
  const win = Math.round(a.rate * 0.02), levels = [];
  let clipped = 0, peak = 0;
  for (let k = 0; k + win <= all.length; k += win) {
    let s = 0; for (let j = k; j < k + win; j++) { const x = all[j]; s += x * x; const ax = Math.abs(x); if (ax > peak) peak = ax; if (ax >= 0.99) clipped++; }
    levels.push(db(Math.sqrt(s / win)));
  }
  const sorted = [...levels].sort((x, y) => x - y);
  const noiseDb = sorted[Math.floor(sorted.length * 0.1)] ?? -120;
  const speech = levels.filter((l) => l > noiseDb + 10);
  const speechDb = speech.length ? speech.reduce((x, y) => x + y, 0) / speech.length : noiseDb;

  // Same 16 kHz PCM path as the app, then Saaras v4 (codemix) via the server.
  const pcm = createResampler(a.rate, 16000)(all);
  const wav = int16ToWav(pcm, 16000);
  const sentence = SENTENCES[a.i].text;
  let r;
  try {
    const resp = await fetch(`/api/lab/transcribe?expect=${encodeURIComponent(sentence)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
    r = await resp.json();
    if (!resp.ok) throw new Error(r.error || resp.statusText);
  } catch (e) {
    res.textContent = `Transcription failed: ${e.message}`;
    return;
  }
  const row = {
    sentence: a.i + 1, mode: a.mode, accuracy: r.accuracy, transcript: r.transcript, language: r.languageCode,
    seconds: +(all.length / a.rate).toFixed(1), speechDb: +speechDb.toFixed(1), noiseDb: +noiseDb.toFixed(1),
    snrDb: +(speechDb - noiseDb).toFixed(1), peakDb: +db(peak).toFixed(1), clippedPct: +((clipped / all.length) * 100).toFixed(2),
    requested: MODES[a.mode].constraints,
    applied: { echoCancellation: a.applied.echoCancellation, noiseSuppression: a.applied.noiseSuppression, autoGainControl: a.applied.autoGainControl },
    sttMs: r.ms,
  };
  const prev = results.findIndex((x) => x.sentence === row.sentence && x.mode === row.mode);
  if (prev >= 0) results.splice(prev, 1);
  results.push(row);

  const mismatch = ['noiseSuppression', 'autoGainControl', 'echoCancellation'].filter((k) => row.applied[k] !== undefined && row.applied[k] !== row.requested[k]);
  res.innerHTML = `<div><span class="acc">${pct(row.accuracy)} accurate</span> · <span class="tx">“${escapeHtml(row.transcript || '(nothing heard)')}”</span></div>
    <div class="m">speech ${row.speechDb} dB · noise ${row.noiseDb} dB · SNR ${row.snrDb} dB · clipped ${row.clippedPct}% · ${row.seconds} s</div>
    ${mismatch.length ? `<div class="m" style="color:var(--warn)">Phone ignored: ${mismatch.join(', ')} (requested ${mismatch.map((k) => row.requested[k]).join('/')})</div>` : ''}
    <div class="row"><button type="button" class="play">▶ Play</button></div>`;
  const url = URL.createObjectURL(wav);
  res.querySelector('.play').addEventListener('click', () => new Audio(url).play());
  summarize();
}

function summarize() {
  const el = $('summary');
  const by = (m) => results.filter((r) => r.mode === m);
  const avg = (rows, k) => (rows.length ? rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length : null);
  const modes = Object.keys(MODES).filter((m) => by(m).length);
  if (!modes.length) { el.hidden = true; return; }
  el.hidden = false;
  // Fair comparison: only sentences recorded in both ON and OFF.
  const paired = SENTENCES.map((_, i) => i + 1).filter((n) => by('on').some((r) => r.sentence === n) && by('off').some((r) => r.sentence === n));
  const diff = paired.length ? avg(paired.map((n) => ({ d: by('on').find((r) => r.sentence === n).accuracy - by('off').find((r) => r.sentence === n).accuracy })), 'd') : null;
  el.innerHTML = `<strong>Results so far (${$('env').value})</strong>
    <table><thead><tr><th>Mode</th><th>Takes</th><th>Avg accuracy</th><th>Avg speech</th><th>Avg noise</th><th>Clipping</th></tr></thead><tbody>
    ${modes.map((m) => `<tr><td>${MODES[m].label}</td><td>${by(m).length}</td><td>${pct(avg(by(m), 'accuracy'))}</td><td>${avg(by(m), 'speechDb').toFixed(1)} dB</td><td>${avg(by(m), 'noiseDb').toFixed(1)} dB</td><td>${avg(by(m), 'clippedPct').toFixed(2)}%</td></tr>`).join('')}
    </tbody></table>
    <p>${paired.length ? `On the ${paired.length} sentence(s) recorded both ways, ON was <b>${diff >= 0 ? '+' : ''}${Math.round(diff * 100)} points</b> ${diff >= 0 ? 'more' : 'less'} accurate than OFF.` : 'Record a sentence both ways to compare.'} Noise levels aren't comparable across modes: noise suppression lowers measured noise by design.</p>`;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

$('copy').addEventListener('click', async (e) => {
  const payload = { test: 'mic processing on vs off', environment: $('env').value, phone: $('phone').value || null, userAgent: navigator.userAgent, at: new Date().toISOString(), results };
  const text = JSON.stringify(payload, null, 2);
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    ta.remove();
  }
  setTimeout(() => (btn.textContent = 'Copy results'), 1500);
});
$('reset').addEventListener('click', () => { results.length = 0; summarize(); render(); });
$('raw').addEventListener('change', render);
render();
