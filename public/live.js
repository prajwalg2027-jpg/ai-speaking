// Realtime STT client: streams the mic to our /api/live relay (→ Sarvam saaras:v4 realtime, server VAD)
// and turns Sarvam's utterance events into "answers" for the placement conversation.
//
// Turn rules:
// - An answer can span several utterances (a learner pauses mid-thought). After each final transcript we
//   wait a short grace period; if VAD reports new speech, we keep collecting.
// - While the bot is talking, a VAD speech_start counts only if the local mic is loud too (barge-in).
//   Otherwise it's treated as echo of the bot's own voice and that utterance is ignored.
// - Utterances that start while the bot is silent (between prompt and listen, or while "thinking") count.
import { createResampler } from '/pcm.js';
import { log, logPartial } from '/log.js';

export class LiveSTT {
  constructor(voice) {
    this.voice = voice;
    this.ws = null;
    this.alive = false;
    this.listener = null;
    this.onBargeIn = null;
    this.beginPrompt();
  }

  /** Open the relay. Resolves true once Sarvam's session is ready, false if it isn't available. */
  connect(timeoutMs = 6000) {
    return new Promise((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/api/live`);
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const settle = (ok, reason) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (!ok) { this.reason = reason; try { ws.close(); } catch {} }
        resolve(ok);
      };
      const timer = setTimeout(() => settle(false, `no session from Sarvam within ${timeoutMs / 1000} s`), timeoutMs);
      log('live', 'Opening /api/live relay to Sarvam Realtime STT');
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.type === 'log') return log('relay', e.msg, e.data);
        if (e.type === 'ready') {
          log('live', 'Sarvam Realtime session started', { requestId: e.requestId, ...e.config });
          this.alive = true; this._startStreaming(); settle(true);
        } else if (e.type === 'unavailable') settle(false, e.reason);
        else this._event(e);
      };
      ws.onclose = (ev) => {
        const wasAlive = this.alive;
        this.alive = false;
        this._stopStreaming();
        if (wasAlive) {
          log('error', `Live connection closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
          this.listener?.onFail();
        }
        settle(false, 'closed');
      };
      this.ws = ws;
    });
  }

  _send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(typeof obj === 'string' || obj instanceof ArrayBuffer ? obj : JSON.stringify(obj)); }

  _startStreaming() {
    const resample = createResampler(this.voice.ctx.sampleRate, 16000);
    this.voice.tap = (buf) => {
      const pcm = resample(buf);
      if (pcm.length) this._send(pcm.buffer);
    };
    log('mic', `Streaming mic to Sarvam: ${this.voice.ctx.sampleRate} Hz → 16 kHz PCM16`);
  }
  _stopStreaming() { this.voice.tap = null; }

  /** Call before each bot prompt: forget utterances from the previous exchange. */
  beginPrompt() {
    this.accepted = new Set();
    this.pending = [];
    this.inUtterance = false;
    this.speechSec = 0;
    this.language = null;
    this.languageConfidence = null;
  }

  _event(e) {
    const accepted = this.accepted.has(e.idx);
    switch (e.type) {
      case 'speech_start': {
        let accept = !!this.listener || !this.voice.isPlaying();
        if (accept) log('live', `VAD: speech started (utterance ${e.idx})`);
        else if (this.voice.userIsLoud()) {
          accept = true;
          log('live', `VAD: speech started during the prompt and the mic is loud: barge-in, stopping the prompt (utterance ${e.idx})`);
          this.onBargeIn?.();
        }
        if (!accept) return log('live', `VAD: speech during the prompt but the mic is quiet: treated as echo, ignored (utterance ${e.idx})`);
        this.accepted.add(e.idx);
        this.inUtterance = true;
        this._utterStart = performance.now();
        return this.listener?.onSpeechStart();
      }
      case 'partial':
        if (accepted) { logPartial(e.text); this.listener?.onPartial([...this.pending, e.text].join(' ')); }
        return;
      case 'speech_end':
        if (!accepted) return;
        log('live', `VAD: speech ended (utterance ${e.idx})`);
        this.inUtterance = false;
        this._wallSpeech = (performance.now() - (this._utterStart ?? performance.now())) / 1000;
        return this.listener?.onSpeechEnd();
      case 'final':
        if (!accepted) return log('live', `Final transcript for ignored utterance ${e.idx} dropped`, e.text);
        log('stt', `Final transcript (utterance ${e.idx})`, { text: e.text, language: e.language, confidence: e.languageConfidence, speechSec: e.speechSec });
        this.inUtterance = false;
        if (e.text?.trim()) this.pending.push(e.text.trim());
        this.speechSec += e.speechSec ?? this._wallSpeech ?? 0;
        if (e.language) { this.language = e.language; this.languageConfidence = e.languageConfidence; }
        return this.listener?.onFinal();
      case 'error':
        log('error', `Sarvam Realtime error: ${e.code}${e.fatal ? ' (fatal)' : ''}`, { message: e.message, status: e.status });
        if (e.fatal) this.ws?.close();
        return;
      case 'closed':
        log('error', `Sarvam closed the live stream (code ${e.code})`, e.reason || undefined);
        return this.ws?.close();
    }
  }

  /**
   * Collect one answer. Resolves { transcript, language, speechSec, reason, live: true }.
   * reason: 'silence' | 'manual' | 'max' | 'no_speech' | 'live_failed' (caller should fall back to REST).
   */
  listen({ silenceMs = 1200, graceMs = 700, maxMs = 45_000, nudgeMs = 6000, giveUpMs = 12_000, onNudge, onPartial } = {}) {
    this._send({ type: 'config', silenceMs });
    this.voice.metering = true;
    log('live', `Listening: Sarvam ends the turn after ${silenceMs} ms of silence, then ${graceMs} ms grace`);
    return new Promise((resolve) => {
      const t0 = performance.now();
      let done = false, nudged = false, grace = null, safety = null, finishing = false;
      const finish = (reason) => {
        if (done) return;
        done = true;
        clearInterval(tick); clearTimeout(grace); clearTimeout(safety);
        this.listener = null; this.voice.stopListening = null; this.voice.metering = false; this.voice.onLevel(0, 'user');
        const spoke = this.accepted.size > 0;
        log('live', `Answer complete (${reason === 'live_failed' || spoke ? reason : 'no speech'})`, { transcript: this.pending.join(' ').trim(), utterances: this.accepted.size, speechSec: +this.speechSec.toFixed(2) });
        resolve({
          transcript: this.pending.join(' ').trim(), language: this.language, languageConfidence: this.languageConfidence,
          speechSec: this.speechSec, reason: reason === 'live_failed' || spoke ? reason : 'no_speech', live: true,
        });
      };
      const requestFinal = (reason) => { // push silence so server VAD closes the utterance now
        log('live', reason === 'max' ? 'Answer hit the 45 s cap: asking Sarvam to finish' : 'Done tapped mid-sentence: asking Sarvam to finish the utterance');
        finishing = reason;
        this._send({ type: 'finish' });
        safety = setTimeout(() => finish(reason), 4000);
      };
      this.listener = {
        onSpeechStart: () => {
          if (grace) log('live', 'Learner continued: adding to the same answer');
          clearTimeout(grace); grace = null; clearTimeout(safety);
        },
        onPartial: (text) => onPartial?.(text),
        onSpeechEnd: () => { safety = setTimeout(() => finish('silence'), 5000); }, // final should follow quickly
        onFinal: () => {
          clearTimeout(grace); clearTimeout(safety);
          if (finishing) return finish(finishing);
          if (!this.inUtterance) {
            log('live', `Waiting ${graceMs} ms in case the learner continues`);
            grace = setTimeout(() => finish('silence'), graceMs);
          }
        },
        onFail: () => finish('live_failed'),
      };
      // Barge-in utterance may already be complete before listen() began.
      if (this.pending.length && !this.inUtterance) this.listener.onFinal();
      if (this.pending.length) onPartial?.(this.pending.join(' '));

      // "Done speaking" / orb tap. immediate=true (skip, repeat…) doesn't wait for the transcript.
      this.voice.stopListening = (immediate = false) => {
        if (immediate || !this.inUtterance) finish('manual');
        else if (!finishing) requestFinal('manual');
      };
      const tick = setInterval(() => {
        const t = performance.now() - t0;
        if (this.accepted.size === 0) {
          if (!nudged && t > nudgeMs) { nudged = true; log('app', `No speech for ${nudgeMs / 1000} s: showing a nudge`); onNudge?.(); }
          if (t > giveUpMs) { log('app', `No speech for ${giveUpMs / 1000} s`); finish('no_speech'); }
        } else if (t > maxMs && !finishing) requestFinal('max');
      }, 200);
    });
  }

  close() { this._stopStreaming(); try { this.ws?.close(); } catch {} }
}
