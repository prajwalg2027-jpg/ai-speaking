// A local stand-in for Sarvam's /speech-to-text-realtime/ws, following the protocol in the sarvamai SDK
// (session.begin, vad.speech_start, transcript.partial, vad.speech_end, transcript.final, config.updated,
// error, session.end, pong). Its VAD is a simple energy detector; the transcript for each utterance comes
// from an injectable `transcribe(pcm16Buffer)` function (fixed text in unit tests, or real Saaras REST
// when you want true transcripts). Used for tests and for local dev where WebSockets can't reach Sarvam.
import { WebSocketServer } from 'ws';

const RATE = 16000;

export function startMockRealtime({ transcribe = async () => 'hello world', port = 0, requireKey = null } = {}) {
  const state = { connections: [], rejectNext: false };
  const wss = new WebSocketServer({
    port,
    verifyClient: (info, cb) => {
      if (state.rejectNext) { state.rejectNext = false; return cb(false, 403, 'Forbidden'); }
      if (requireKey && info.req.headers['api-subscription-key'] !== requireKey) return cb(false, 403, 'Forbidden');
      cb(true);
    },
  });

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const conn = { query: Object.fromEntries(q), headers: req.headers, configUpdates: [], audioBytes: 0 };
    state.connections.push(conn);
    const send = (o) => ws.send(JSON.stringify(o));
    const cfg = {
      model: q.get('model') || 'saaras:v3-realtime', language_code: q.get('language_code'), encoding: q.get('encoding'),
      sample_rate: Number(q.get('sample_rate')), mode: q.get('mode') || 'transcribe', stream_type: q.get('stream_type') || 'balanced',
      turn_detection: q.get('endpointing') || 'vad', silence_duration_ms: Number(q.get('silence_duration_ms') || 500),
      threshold: Number(q.get('threshold') || 0.3), return_timestamps: q.get('return_timestamps') === 'true',
    };
    if (!q.get('language_code')) { send({ event: 'error', code: 'invalid_config', is_fatal: true, message: 'language_code required', status_code: 400 }); return ws.close(4000, 'language_code required'); }
    send({ event: 'session.begin', request_id: `mock_${state.connections.length}`, config: cfg });

    let t = 0; // samples received
    let idx = 0, inSpeech = false, silent = 0, utter = [], startSample = 0, lastPartialAt = 0;
    const finalize = async (endSample) => {
      inSpeech = false;
      const my = idx++;
      send({ event: 'vad.speech_end', utterance_idx: my, confidence: 0.9 });
      const text = await transcribe(Buffer.concat(utter), cfg);
      send({
        event: 'transcript.final', utterance_idx: my, text,
        ...(cfg.language_code === 'auto' ? { language: /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-IN', language_confidence: 0.95 } : {}),
        ...(cfg.return_timestamps ? { start_s: startSample / RATE, end_s: endSample / RATE } : {}),
      });
    };
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw);
      if (m.event === 'ping') return send({ event: 'pong' });
      if (m.event === 'config.update') {
        conn.configUpdates.push(m);
        const applied = Object.keys(m).filter((k) => k !== 'event');
        for (const k of applied) cfg[k] = m[k];
        return send({ event: 'config.updated', applied });
      }
      if (m.event === 'end') {
        // Like Sarvam: finalise any utterance in progress, then end the session.
        if (inSpeech) await finalize(t - silent);
        send({ event: 'session.end', request_id: 'mock', total_utterances: idx, audio_duration_s: +(conn.audioBytes / 2 / RATE).toFixed(2) });
        return ws.close(1000);
      }
      if (m.event !== 'audio_input') return;
      const buf = Buffer.from(m.audio, 'base64');
      conn.audioBytes += buf.length;
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
      let sum = 0; for (const s of pcm) sum += (s / 32768) ** 2;
      const rms = Math.sqrt(sum / (pcm.length || 1));
      const voiced = rms > 0.02;
      if (voiced && !inSpeech) {
        inSpeech = true; silent = 0; utter = []; startSample = t;
        send({ event: 'vad.speech_start', utterance_idx: idx, confidence: 0.9 });
      }
      if (inSpeech) {
        utter.push(Buffer.from(buf));
        silent = voiced ? 0 : silent + pcm.length;
        if (t - lastPartialAt > RATE * 0.5 && voiced) { lastPartialAt = t; send({ event: 'transcript.partial', utterance_idx: idx, text: '…' }); }
        if (silent >= (cfg.silence_duration_ms / 1000) * RATE) await finalize(t + pcm.length - silent);
      }
      t += pcm.length;
    });
  });

  return new Promise((resolve) => wss.on('listening', () => resolve({ wss, state, url: `ws://127.0.0.1:${wss.address().port}/speech-to-text-realtime/ws`, close: () => new Promise((r) => wss.close(r)) })));
}
