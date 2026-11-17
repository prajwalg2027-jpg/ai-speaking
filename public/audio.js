// Mic capture + energy VAD + 16 kHz WAV encoding + TTS playback, all driving an "orb level".
import { log } from '/log.js';

export class Voice {
  constructor(onLevel) {
    this.onLevel = onLevel; // (0..1, 'user'|'bot') => void
    this.ctx = null;
  }

  async init() {
    this.ctx = new AudioContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but universally supported; swap for an AudioWorklet in production.
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => this._frame(e.inputBuffer.getChannelData(0));
    this.noiseFloor = 0.01;
    this.tap = null; // per-frame mic consumer (realtime streaming)
    this.metering = false; // drive the orb from the mic level
    this.localBargeIn = true; // false when realtime VAD handles barge-in
    this.playing = false;
    this.lastLoudAt = -Infinity;
    this.botAnalyser = this.ctx.createAnalyser();
    this.botAnalyser.fftSize = 512;
    this.botAnalyser.connect(this.ctx.destination);
    const st = this.stream.getAudioTracks()[0]?.getSettings?.() || {};
    log('mic', 'Microphone on', {
      sampleRate: this.ctx.sampleRate, echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression,
      autoGainControl: st.autoGainControl, channelCount: st.channelCount,
    });
  }

  _frame(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const ms = (buf.length / this.ctx.sampleRate) * 1000;
    // Continuous noise-floor estimate: drops quickly in quiet, rises very slowly, and is capped, so a user
    // who starts talking the instant the mic opens is never mistaken for background noise.
    const nf = this.noiseFloor;
    this.noiseFloor = Math.min(0.015, rms < nf ? nf * 0.8 + rms * 0.2 : nf * 0.999 + rms * 0.001);
    if (rms > this.threshold * 2) this.lastLoudAt = performance.now();
    if (this.metering) this.onLevel(Math.min(1, rms / (this.threshold * 6)), 'user');
    this.tap?.(buf);
    this._frameHook?.(rms, ms, buf);
  }

  get threshold() { return Math.max(0.012, this.noiseFloor * 3); }

  isPlaying() { return this.playing || (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking); }

  /** Has the user been clearly louder than the noise floor in the last 400 ms? (barge-in check) */
  userIsLoud() { return performance.now() - this.lastLoudAt < 400; }

  /**
   * Record one answer. Resolves with { wav, speechSec, durationSec, reason }.
   * reason: 'silence' (normal end) | 'manual' | 'max' | 'no_speech'
   * opts.onNudge fires after nudgeMs of no speech.
   */
  listen({ silenceMs = 1200, maxMs = 45_000, nudgeMs = 6000, giveUpMs = 12_000, onNudge } = {}) {
    return new Promise((resolve) => {
      const chunks = [];
      let t = 0, spoke = false, lastVoice = 0, speechMs = 0, nudged = false;
      log('mic', `Listening with the browser's speech detector: turn ends after ${silenceMs} ms of silence`, { noiseFloor: +this.noiseFloor.toFixed(4), threshold: +this.threshold.toFixed(4) });
      const finish = (reason) => {
        this._frameHook = null; this.stopListening = null; this.onLevel(0, 'user');
        const wav = encodeWav(chunks, this.ctx.sampleRate, 16000);
        log('mic', `Recording finished (${spoke ? reason : 'no speech'})`, { speechSec: +(speechMs / 1000).toFixed(2), recordedSec: +(t / 1000).toFixed(2), wavKB: +(wav.size / 1024).toFixed(1) });
        resolve({ wav, speechSec: speechMs / 1000, durationSec: t / 1000, reason: spoke ? reason : 'no_speech' });
      };
      this.stopListening = () => finish('manual');
      this._frameHook = (rms, ms, buf) => {
        t += ms;
        chunks.push(new Float32Array(buf));
        const voiced = rms > this.threshold;
        if (!this.metering) this.onLevel(Math.min(1, rms / (this.threshold * 6)), 'user');
        if (voiced) {
          if (!spoke) log('mic', 'Speech detected', { level: +rms.toFixed(4), threshold: +this.threshold.toFixed(4) });
          spoke = true; lastVoice = t; speechMs += ms;
        }
        if (spoke && t - lastVoice > silenceMs) return finish('silence');
        if (!spoke && !nudged && t > nudgeMs) { nudged = true; log('app', `No speech for ${nudgeMs / 1000} s: showing a nudge`); onNudge?.(); }
        if (!spoke && t > giveUpMs) { log('app', `No speech for ${giveUpMs / 1000} s`); return finish('no_speech'); }
        if (t > maxMs) finish('max');
      };
    });
  }

  /** Play base64 WAV. Resolves when finished or interrupted by barge-in / stop(). */
  async play(base64) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await this.ctx.decodeAudioData(bytes.buffer);
    return new Promise((resolve) => {
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.botAnalyser);
      const data = new Uint8Array(this.botAnalyser.fftSize);
      let raf, loud = 0;
      const tick = () => {
        this.botAnalyser.getByteTimeDomainData(data);
        let s = 0; for (const v of data) s += ((v - 128) / 128) ** 2;
        this.onLevel(Math.min(1, Math.sqrt(s / data.length) * 4), 'bot');
        raf = requestAnimationFrame(tick);
      };
      // Local barge-in (REST mode): sustained loud mic input, well above the speech threshold to resist
      // echo, stops playback. In realtime mode Sarvam's VAD drives barge-in instead (see live.js).
      let stoppedBy = null;
      if (this.localBargeIn) this._frameHook = (rms, ms) => {
        loud = rms > this.threshold * 4 ? loud + ms : 0;
        if (loud > 300 && !stoppedBy) { stoppedBy = 'barge-in (mic loud for 300 ms)'; node.stop(); }
      };
      this.stopPlayback = () => { stoppedBy ||= 'stopped by app'; try { node.stop(); } catch {} };
      const started = this.ctx.currentTime;
      node.onended = () => {
        cancelAnimationFrame(raf); this.playing = false; this.stopPlayback = null;
        if (this.localBargeIn) this._frameHook = null;
        const played = this.ctx.currentTime - started;
        if (stoppedBy) log('tts', `Prompt cut short after ${played.toFixed(1)} of ${buffer.duration.toFixed(1)} s: ${stoppedBy}`);
        else log('tts', `Prompt finished playing (${buffer.duration.toFixed(1)} s)`);
        this.onLevel(0, 'bot'); resolve();
      };
      this.playing = true;
      log('tts', `Playing prompt audio (${buffer.duration.toFixed(1)} s, ${buffer.sampleRate} Hz)`);
      node.start(); tick();
    });
  }
}

/** Float32 chunks at srcRate → 16-bit mono WAV at dstRate. */
export function encodeWav(chunks, srcRate, dstRate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(len);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = srcRate / dstRate, outLen = Math.floor(len / ratio);
  const buf = new ArrayBuffer(44 + outLen * 2), v = new DataView(buf);
  const str = (p, s) => [...s].forEach((ch, i) => v.setUint8(p + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + outLen * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, dstRate, true); v.setUint32(28, dstRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    // Average over the decimation window (cheap low-pass).
    let s = 0, n = 0; for (let j = Math.floor(i * ratio); j < Math.floor((i + 1) * ratio); j++) { s += all[j]; n++; }
    const x = Math.max(-1, Math.min(1, s / (n || 1)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
