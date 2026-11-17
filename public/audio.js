// Mic capture (feeds live.js), barge-in detection, and prompt playback — all driving the orb's level.
import { log } from '/log.js';

export class Voice {
  constructor(onLevel) {
    this.onLevel = onLevel; // (0..1, 'user'|'bot') => void
    this.ctx = null;
    this.onBargeIn = null; // called with (msSinceSpeechStarted) when the learner talks over a prompt
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
    if (rms > this.threshold * 2) this.lastLoudAt = performance.now();
    if (this.metering) this.onLevel(Math.min(1, rms / (this.threshold * 6)), 'user');
    this.tap?.(buf);
    this._frameHook?.(rms, ms, buf);
  }

  get threshold() { return Math.max(0.012, this.noiseFloor * 3); }

  isPlaying() { return this.playing; }

  /** Has the user been clearly louder than the noise floor in the last 400 ms? */
  userIsLoud() { return performance.now() - this.lastLoudAt < 400; }

  /**
   * Play base64 WAV. Resolves when finished, when stopped, or on barge-in: the mic well above the speech
   * threshold for 300 ms while the prompt plays (echo cancellation keeps Sakhi's voice out of it). The loud
   * counter drains slowly instead of resetting, so normal dips inside words don't delay detection.
   */
  async play(base64) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await this.ctx.decodeAudioData(bytes.buffer);
    return new Promise((resolve) => {
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.botAnalyser);
      const data = new Uint8Array(this.botAnalyser.fftSize);
      let raf, loud = 0, stoppedBy = null, onsetAt = null, quietMs = 0;
      const tick = () => {
        this.botAnalyser.getByteTimeDomainData(data);
        let s = 0; for (const v of data) s += ((v - 128) / 128) ** 2;
        this.onLevel(Math.min(1, Math.sqrt(s / data.length) * 4), 'bot');
        raf = requestAnimationFrame(tick);
      };
      this._frameHook = (rms, ms) => {
        // When did this stretch of sound start? (so live.js can send audio from that point)
        if (rms > this.threshold) { onsetAt ??= performance.now() - ms; quietMs = 0; }
        else if ((quietMs += ms) > 400) onsetAt = null;
        loud = rms > this.threshold * 4 ? loud + ms : Math.max(0, loud - ms / 2);
        if (loud > 300 && !stoppedBy) {
          const leadMs = Math.round(performance.now() - (onsetAt ?? performance.now() - 300));
          stoppedBy = `barge-in: learner spoke over the prompt (speech started ${leadMs} ms earlier)`;
          this.onBargeIn?.(leadMs);
          node.stop();
        }
      };
      this.stopPlayback = () => { stoppedBy ||= 'stopped by app'; try { node.stop(); } catch {} };
      const started = this.ctx.currentTime;
      node.onended = () => {
        cancelAnimationFrame(raf); this.playing = false; this.stopPlayback = null; this._frameHook = null;
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
