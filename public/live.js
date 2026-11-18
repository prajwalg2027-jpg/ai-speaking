// Realtime speech-to-text: streams the mic to our /api/live relay (→ Sarvam saaras:v4 realtime, server VAD)
// and turns Sarvam's utterance events into "answers" for the placement conversation.
//
// Streaming rules (Sarvam bills every second of audio it receives):
// - Audio is streamed only while we're listening for an answer. While Sakhi talks or the server is
//   scoring, mic audio is kept in a short pre-roll buffer instead of being sent.
// - When listening starts, the end of that buffer is sent first, so the start of an answer isn't lost:
//   after a barge-in, everything since the learner started talking (up to 2 s); otherwise 250 ms.
// - Barge-in is detected locally from the mic level (audio.js), because nothing is streamed during prompts.
//
// Turn rules:
// - An answer can span several utterances (a learner pauses mid-thought). After each final transcript we
//   wait a short grace period; if VAD reports new speech, we keep collecting.
import { createResampler } from '/pcm.js';
import { log, logPartial } from '/log.js';

const RATE = 16000;
const PREROLL_MS = 2000;         // kept while not streaming
const PREROLL_AFTER_PROMPT = 250; // sent when listening starts after a prompt finished normally

export class LiveSTT {
  constructor(voice) {
    this.voice = voice;
    this.ws = null;
    this.alive = false;
    this.listener = null;
    this.streaming = false;
    this.bargeInPrerollMs = null; // set by the app when the learner interrupted the last prompt
    this.ring = []; this.ringSamples = 0;
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
          this.alive = true; this._startTap(); settle(true);
          if (this.sessionId) this._send({ type: 'bind', sessionId: this.sessionId }); // after a reconnect
        } else if (e.type === 'unavailable') {
          log('error', 'Sarvam Realtime unavailable', e.reason);
          settle(false, e.reason);
        } else this._event(e);
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return; // an older socket closing after a reconnect
        const wasAlive = this.alive;
        this.alive = false;
        this.streaming = false;
        this.voice.tap = null;
        if (wasAlive) {
          log('error', `Live connection closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''}). It reopens at the next answer.`);
          this.listener?.onFail();
        }
        settle(false, `closed (code ${ev.code})`);
      };
      this.ws = ws;
    });
  }

  /** Tell the relay which conversation this audio belongs to (for its cost). */
  bind(sessionId) {
    this.sessionId = sessionId;
    this._send({ type: 'bind', sessionId });
  }

  /** Reconnect if Sarvam closed the session (e.g. after a long idle period). */
  async ensureConnected() {
    if (this.alive) return true;
    log('live', 'Reconnecting to Sarvam Realtime');
    return this.connect();
  }

  _send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(obj instanceof ArrayBuffer ? obj : JSON.stringify(obj));
  }

  _startTap() {
    const resample = createResampler(this.voice.ctx.sampleRate, RATE);
    this.ring = []; this.ringSamples = 0; this.streaming = false;
    this.voice.tap = (buf) => {
      const pcm = resample(buf);
      if (!pcm.length) return;
      if (this.streaming) return this._send(pcm.buffer);
      // Not listening: keep the last PREROLL_MS of audio, send nothing (nothing billed).
      this.ring.push(pcm); this.ringSamples += pcm.length;
      while (this.ring.length > 1 && this.ringSamples - this.ring[0].length >= (RATE * PREROLL_MS) / 1000) {
        this.ringSamples -= this.ring.shift().length;
      }
    };
    log('mic', `Mic → 16 kHz PCM16 (${this.voice.ctx.sampleRate} Hz input). Streaming only while listening for an answer.`);
  }

  _startStreaming(prerollMs) {
    // Send the newest `prerollMs` of buffered audio, oldest first, then stream live.
    let need = Math.round((RATE * prerollMs) / 1000), parts = [];
    for (let i = this.ring.length - 1; i >= 0 && need > 0; i--) {
      const c = this.ring[i];
      parts.unshift(c.length <= need ? c : c.subarray(c.length - need));
      need -= c.length;
    }
    for (const p of parts) this._send(p.slice().buffer);
    this.ring = []; this.ringSamples = 0;
    this.streaming = true;
    log('live', `Streaming to Sarvam (sent ${prerollMs} ms of pre-roll${prerollMs !== PREROLL_AFTER_PROMPT ? ' covering the start of the interruption' : ''})`);
  }

  _stopStreaming() {
    if (!this.streaming) return;
    this.streaming = false;
    log('live', 'Paused streaming until the next answer (Sakhi talking or scoring: not billed)');
  }

  /** Call before each bot prompt: forget utterances from the previous exchange. */
  beginPrompt() {
    this.accepted = new Set();
    this.pending = [];
    this.open = new Set(); // utterances that started and whose final transcript hasn't arrived yet
    this.speechSec = 0;
    this.language = null;
    this.languageConfidence = null;
  }

  _event(e) {
    const accepted = this.accepted.has(e.idx);
    switch (e.type) {
      case 'speech_start':
        if (!this.listener) return log('live', `VAD: speech started outside an answer window, ignored (utterance ${e.idx})`);
        log('live', `VAD: speech started (utterance ${e.idx})`);
        this.accepted.add(e.idx);
        this.open.add(e.idx);
        this._utterStart = performance.now();
        return this.listener.onSpeechStart();
      case 'partial':
        if (accepted) { logPartial(e.text); this.listener?.onPartial([...this.pending, e.text].join(' ')); }
        return;
      case 'speech_end':
        if (!accepted) return;
        log('live', `VAD: speech ended (utterance ${e.idx})`);
        this._wallSpeech = (performance.now() - (this._utterStart ?? performance.now())) / 1000;
        return this.listener?.onSpeechEnd();
      case 'final':
        if (!accepted) return log('live', `Final transcript for ignored utterance ${e.idx} dropped`, e.text);
        log('stt', `Final transcript (utterance ${e.idx})`, { text: e.text, language: e.language, confidence: e.languageConfidence, speechSec: e.speechSec });
        // A final can arrive after the learner has started the next stretch of speech: only that utterance closes.
        this.open.delete(e.idx);
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
   * Collect one answer. Resolves { transcript, language, speechSec, reason }.
   * reason: 'silence' | 'manual' | 'max' | 'no_speech' | 'live_failed' (connection dropped mid-answer).
   */
  listen({ silenceMs = 1200, language = 'auto', graceMs = 700, maxMs = 45_000, nudgeMs = 6000, giveUpMs = 12_000, onNudge, onPartial } = {}) {
    // Set this answer's language. 'auto' re-arms detection, which Sarvam otherwise keeps from the first
    // answer for the whole session (a learner who answered Q1 in Hindi would stay "Hindi").
    this._send({ type: 'config', silenceMs, language });
    log('live', language === 'auto' ? 'Language: detect again for this answer' : `Language: fixed to ${language} for this answer`);
    this.voice.metering = true;
    log('live', `Listening: Sarvam ends the turn after ${silenceMs} ms of silence, then ${graceMs} ms grace`);
    this._startStreaming(this.bargeInPrerollMs ?? PREROLL_AFTER_PROMPT);
    this.bargeInPrerollMs = null;
    return new Promise((resolve) => {
      const t0 = performance.now();
      let done = false, nudged = false, grace = null, safety = null, finishing = false;
      const finish = (reason) => {
        if (done) return;
        done = true;
        clearInterval(tick); clearTimeout(grace); clearTimeout(safety);
        this.listener = null; this.voice.stopListening = null; this.voice.metering = false; this.voice.onLevel(0, 'user');
        this._stopStreaming();
        const spoke = this.accepted.size > 0;
        const why = reason === 'live_failed' || spoke ? reason : 'no_speech';
        log('live', `Answer complete (${why})`, { transcript: this.pending.join(' ').trim(), utterances: this.accepted.size, speechSec: +this.speechSec.toFixed(2) });
        resolve({ transcript: this.pending.join(' ').trim(), language: this.language, languageConfidence: this.languageConfidence, speechSec: this.speechSec, reason: why });
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
          // Learners switch language mid-answer (a Hindi sentence, a pause, then English): re-detect for
          // the next stretch of speech too. Applies at the next utterance boundary, never mid-utterance.
          if (language === 'auto') this._send({ type: 'config', language: 'auto' });
          clearTimeout(grace); clearTimeout(safety);
          if (finishing) return finish(finishing);
          if (this.open.size === 0) {
            log('live', `Waiting ${graceMs} ms in case the learner continues`);
            grace = setTimeout(() => finish('silence'), graceMs);
          } else log('live', 'Learner is still talking (a later utterance is open): keeping the answer open');
        },
        onFail: () => finish('live_failed'),
      };

      // "Done speaking" / orb tap. immediate=true (skip, repeat…) doesn't wait for the transcript.
      this.voice.stopListening = (immediate = false) => {
        if (immediate || this.open.size === 0) finish('manual');
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

  close() { this.voice.tap = null; try { this.ws?.close(); } catch {} }
}
