// Realtime speech-to-text: streams the mic to our /api/live relay (→ Sarvam saaras:v4 realtime, server VAD)
// and turns Sarvam's utterance events into "answers" for the placement conversation.
//
// Streaming rules (Sarvam bills every second of audio it receives):
// - Audio is streamed only while we're listening for an answer. While Sakhi talks or the server is
//   scoring, mic audio is kept in a short pre-roll buffer instead of being sent.
// - When listening starts, the buffered audio is sent first, from where the learner's speech began (300 ms
//   before it, at most 3 s back; 250 ms if they're quiet). Every buffered piece carries its time, so this holds
//   however long it takes to start listening (a reconnect included): nothing said after an interruption is
//   lost, and neither is speech that ran over the end of Sakhi's line without interrupting her.
// - Barge-in is detected locally from the mic level (audio.js), because nothing is streamed during prompts.
//
// Turn rules:
// - An answer can span several utterances (a learner pauses mid-thought). After each final transcript we
//   wait a short grace period; if VAD reports new speech, we keep collecting.
import { createResampler } from '/pcm.js';
import { log, logPartial } from '/log.js';

const RATE = 16000;
const BUFFER_MS = 10_000;         // mic audio kept while not streaming (covers a slow reconnect)
const PREROLL_AFTER_PROMPT = 250; // sent when listening starts and the learner is quiet
const ONSET_MARGIN = 300;         // sent before the detected start of speech (soft first sounds)
const MAX_LOOKBACK = 3000;        // never further back than this (it would be Sakhi's echo, not the learner)

export class LiveSTT {
  constructor(voice) {
    this.voice = voice;
    this.ws = null;
    this.alive = false;
    this.listener = null;
    this.streaming = false;
    this.bargeInAt = null; // when the learner started talking over the last prompt (set by the app)
    this.ring = []; this.ringSamples = 0; // [{ pcm, end: performance.now() at the end of the piece }]
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
      // Not listening: keep the last BUFFER_MS of audio with its time, send nothing (nothing billed).
      this.ring.push({ pcm, end: performance.now() }); this.ringSamples += pcm.length;
      while (this.ring.length > 1 && this.ringSamples - this.ring[0].pcm.length >= (RATE * BUFFER_MS) / 1000) {
        this.ringSamples -= this.ring.shift().pcm.length;
      }
    };
    log('mic', `Mic → 16 kHz PCM16 (${this.voice.ctx.sampleRate} Hz input). Streaming only while listening for an answer.`);
  }

  /** Send buffered audio from time `from` (performance.now() clock), oldest first, then stream live. */
  _startStreaming(from, why) {
    const now = performance.now();
    from = Math.max(from, now - MAX_LOOKBACK);
    let sent = 0;
    for (const { pcm, end } of this.ring) {
      const start = end - (pcm.length / RATE) * 1000;
      if (end <= from) continue;
      const piece = start >= from ? pcm : pcm.subarray(Math.round(((from - start) / 1000) * RATE));
      this._send(piece.slice().buffer); sent += piece.length;
    }
    this.ring = []; this.ringSamples = 0;
    this.streaming = true;
    log('live', `Streaming to Sarvam (sent ${Math.round((sent / RATE) * 1000)} ms buffered${why ? `: ${why}` : ''})`);
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
    // From where the learner started talking: over Sakhi (a barge-in), or just now, while she finished her line.
    const now = performance.now(), talking = this.voice.speechOnsetAt;
    if (this.bargeInAt != null) this._startStreaming(this.bargeInAt - ONSET_MARGIN, 'from the start of the interruption');
    else if (talking != null) this._startStreaming(Math.min(now - PREROLL_AFTER_PROMPT, talking - ONSET_MARGIN), 'the learner was already talking');
    else this._startStreaming(now - PREROLL_AFTER_PROMPT);
    this.bargeInAt = null;
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
