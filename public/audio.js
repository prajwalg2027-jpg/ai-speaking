// Mic capture (feeds live.js), barge-in detection, and streamed playback of Sakhi's voice — all driving the orb's level.
import { log } from '/log.js';

export class Voice {
  constructor(onLevel) {
    this.onLevel = onLevel; // (0..1, 'user'|'bot') => void
    this.ctx = null;
    this.onBargeIn = null; // called with (speechOnsetTime) when the learner talks over a prompt
    this.speechOnsetAt = null; // performance.now() when the current stretch of speech began (null in silence)
  }

  /**
   * Open the mic. Echo cancellation stays on (it stops Sakhi's own voice from looking like an interruption).
   * Noise suppression and auto gain default on; ?ns=0 / ?agc=0 in the page URL turn them off for experiments.
   */
  async init({ noiseSuppression = true, autoGainControl = true } = {}) {
    this.ctx = new AudioContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression, autoGainControl, channelCount: 1 },
    });
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated; replacing it depends on how the Android app is built (see docs/backlog.md).
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => this._frame(e.inputBuffer.getChannelData(0));
    this.noiseFloor = 0.01;
    this.tap = null; // per-frame mic consumer (live.js)
    this.metering = false; // drive the orb from the mic level
    this.playing = false;
    this.lastLoudAt = -Infinity;
    this.botAnalyser = this.ctx.createAnalyser();
    this.botAnalyser.fftSize = 512;
    this.botAnalyser.connect(this.ctx.destination);
    const st = this.stream.getAudioTracks()[0]?.getSettings?.() || {};
    log('mic', 'Microphone on', {
      requested: { echoCancellation: true, noiseSuppression, autoGainControl },
      applied: { echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression, autoGainControl: st.autoGainControl },
      sampleRate: this.ctx.sampleRate, device: st.deviceId ? 'default' : undefined,
    });
  }

  _frame(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const ms = (buf.length / this.ctx.sampleRate) * 1000;
    // Continuous noise-floor estimate: drops quickly in quiet, rises very slowly, and is capped.
    const nf = this.noiseFloor;
    this.noiseFloor = Math.min(0.015, rms < nf ? nf * 0.8 + rms * 0.2 : nf * 0.999 + rms * 0.001);
    const now = performance.now();
    if (rms > this.threshold * 2) this.lastLoudAt = now;
    // Where the current stretch of speech began (kept through short dips inside words; cleared after 400 ms of
    // quiet). The start of an answer is sent from here, so nothing the learner said is lost.
    if (rms > this.threshold) { this.speechOnsetAt ??= now - ms; this._quietMs = 0; }
    else if ((this._quietMs = (this._quietMs || 0) + ms) > 400) this.speechOnsetAt = null;
    if (this.metering) this.onLevel(Math.min(1, rms / (this.threshold * 6)), 'user');
    this.tap?.(buf);
    this._frameHook?.(rms, ms, buf);
    if (this._timing) this._timing.push([rms > this.threshold, ms]);
  }

  /** Start measuring when the learner is voicing and where they pause (for fluency). */
  startTiming() { this._timing = []; }

  /**
   * Stop measuring. → { spanSec: first to last voiced moment, voicedSec, pauses: [seconds, each ≥ 0.25 s] },
   * or null if they didn't speak. Dips under 0.25 s are gaps inside words, not pauses.
   */
  stopTiming() {
    const frames = this._timing || [];
    this._timing = null;
    const first = frames.findIndex(([v]) => v), last = frames.findLastIndex(([v]) => v);
    if (first < 0) return null;
    let span = 0, voiced = 0, gap = 0;
    const pauses = [];
    for (let i = first; i <= last; i++) {
      const [v, ms] = frames[i];
      span += ms;
      if (v) { voiced += ms; if (gap >= 250) pauses.push(+(gap / 1000).toFixed(2)); gap = 0; } else gap += ms;
    }
    return { spanSec: +(span / 1000).toFixed(2), voicedSec: +(voiced / 1000).toFixed(2), pauses };
  }

  get threshold() { return Math.max(0.012, this.noiseFloor * 3); }

  isPlaying() { return this.playing; }

  /** Has the user been clearly louder than the noise floor in the last 400 ms? */
  userIsLoud() { return performance.now() - this.lastLoudAt < 400; }

  /**
   * Play 16-bit mono PCM as it arrives: `chunks` is an async iterable of Uint8Array (a streamed response,
   * or a single cached clip). Each piece is scheduled right after the previous one, so playback starts with
   * the first piece.
   *
   * Interruptions: the moment the learner's voice is clearly above the noise (4× the threshold), Sakhi's
   * volume drops to a quarter, so she isn't talking over them and echo cancellation doesn't swallow their first
   * words. If the voice stays up for 300 ms (the loud counter drains slowly, so dips inside words don't reset
   * it), she stops: a barge-in. If it was just a cough or a bump, her volume comes back after 600 ms.
   * Resolves { stoppedBy: 'barge-in' | 'stopped by app' | null, heardSec } when playback ends or stops.
   * onProgress({ played, total, complete }) is called every frame: seconds heard so far, seconds received so far,
   * and whether the whole clip has arrived (the screen reveals Sakhi's words with it).
   */
  async playPcm(chunks, rate = 24000, { onProgress } = {}) {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const nodes = [];
    const gain = this.ctx.createGain();
    gain.connect(this.botAnalyser);
    let at = this.ctx.currentTime + 0.05, total = 0, leftover = null;
    let raf, loud = 0, stoppedBy = null, duckedAt = null, result = null, complete = false;
    const stopAll = () => { for (const n of nodes) { try { n.stop(); } catch {} } };
    const setVolume = (v) => gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    const data = new Uint8Array(this.botAnalyser.fftSize);
    const tick = () => {
      this.botAnalyser.getByteTimeDomainData(data);
      let s = 0; for (const v of data) s += ((v - 128) / 128) ** 2;
      this.onLevel(Math.min(1, Math.sqrt(s / data.length) * 4), 'bot');
      if (onProgress && !stoppedBy) onProgress({ played: Math.max(0, this.ctx.currentTime - started - 0.05 - (this.ctx.outputLatency || 0)), total, complete });
      raf = requestAnimationFrame(tick);
    };
    this._frameHook = (rms, ms) => {
      if (stoppedBy) return;
      const now = performance.now();
      if (rms > this.threshold * 4) {
        loud += ms;
        if (duckedAt == null) { duckedAt = now; setVolume(0.25); }
      } else loud = Math.max(0, loud - ms / 2);
      if (loud > 300) {
        const onset = this.speechOnsetAt ?? now - 300;
        stoppedBy = `barge-in: learner spoke over Sakhi (speech started ${Math.round(now - onset)} ms earlier)`;
        this.onBargeIn?.(onset);
        stopAll();
      } else if (duckedAt != null && loud === 0 && now - duckedAt > 600) { duckedAt = null; setVolume(1); }
    };
    this.stopPlayback = () => { stoppedBy ||= 'stopped by app'; stopAll(); };
    this.playing = true;
    const started = this.ctx.currentTime;
    tick();
    try {
      for await (const chunk of chunks) {
        if (stoppedBy) break;
        const bytes = leftover ? concat(leftover, chunk) : chunk;
        const n = bytes.length >> 1;
        leftover = bytes.length & 1 ? bytes.slice(n * 2) : null;
        if (!n) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
        const buf = this.ctx.createBuffer(1, n, rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
        const node = this.ctx.createBufferSource();
        node.buffer = buf; node.connect(gain);
        at = Math.max(at, this.ctx.currentTime + 0.02); // if the network fell behind, carry on just ahead of now
        node.start(at); at += buf.duration; total += buf.duration;
        nodes.push(node);
      }
      complete = true;
      while (!stoppedBy && this.ctx.currentTime < at) await new Promise((r) => setTimeout(r, 40));
    } finally {
      cancelAnimationFrame(raf); this.playing = false; this.stopPlayback = null; this._frameHook = null;
      this.onLevel(0, 'bot');
      // What reached the learner's ears: time played, minus the 50 ms lead-in and the device's output delay.
      const played = Math.max(0, Math.min(total, this.ctx.currentTime - started - 0.05 - (this.ctx.outputLatency || 0)));
      if (stoppedBy) log('tts', `Sakhi cut short after ${played.toFixed(1)} s${total ? ` of ${total.toFixed(1)} s received` : ''}: ${stoppedBy}`);
      else log('tts', `Sakhi finished speaking (${total.toFixed(1)} s)`);
      if (duckedAt != null && !stoppedBy) log('tts', 'Lowered Sakhi\'s volume for a moment (a sound that wasn\'t an interruption)');
      setTimeout(() => gain.disconnect(), 200);
      result = { stoppedBy: stoppedBy?.startsWith('barge-in') ? 'barge-in' : stoppedBy, heardSec: +played.toFixed(2), totalSec: +total.toFixed(2) };
    }
    return result;
  }
}

function concat(a, b) { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }

/** Async iterable over a fetch Response body, calling onFirst() when the first bytes arrive. */
export async function* readBody(res, onFirst) {
  const reader = res.body.getReader();
  let first = true;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (first && value?.length) { first = false; onFirst?.(); }
      yield value;
    }
  } finally { reader.cancel().catch(() => {}); }
}
