// Realtime STT relay: browser <-> /api/live <-> Sarvam /speech-to-text-realtime/ws.
//
// The browser never sees the API key. It streams raw PCM16 16 kHz mono as binary frames and
// receives simple JSON events. Protocol upstream follows Sarvam's realtime API (sarvamai SDK 1.1.x):
//   client → Sarvam: {event:"audio_input", audio:<base64>}, {event:"config.update", ...}, {event:"end"}, {event:"ping"}
//   Sarvam → client: session.begin, vad.speech_start, transcript.partial, vad.speech_end,
//                    transcript.final, config.updated, error, session.end, pong
//
// Browser protocol (ours):
//   browser → relay: binary PCM16 frames; JSON {type:"config", silenceMs}, {type:"finish"}
//   relay → browser: {type:"ready"}, {type:"speech_start", idx}, {type:"partial", idx, text},
//                    {type:"speech_end", idx}, {type:"final", idx, text, language, languageConfidence, speechSec},
//                    {type:"unavailable", reason} (then close: browser falls back to REST)

import WebSocket, { WebSocketServer } from 'ws';
import { config } from './config.js';

const S = config.sarvam;
const SAMPLE_RATE = 16000;

/** Optional HTTPS proxy agent (only when HTTPS_PROXY is set and https-proxy-agent is installed). */
let proxyAgent;
async function getProxyAgent(url) {
  if (proxyAgent !== undefined) return proxyAgent;
  proxyAgent = null;
  if (process.env.HTTPS_PROXY && url.startsWith('wss:')) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      proxyAgent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    } catch { /* not installed: connect directly */ }
  }
  return proxyAgent;
}

export function upstreamUrl({ silenceMs = 1200 } = {}) {
  const qs = new URLSearchParams({
    model: S.realtime.model,
    language_code: 'auto', // adaptive language ID; finals then carry `language` + `language_confidence`
    mode: S.sttMode, // codemix: English in Latin script, Hindi in Devanagari (applies to finals)
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    endpointing: 'vad', // server-side turn detection
    silence_duration_ms: String(silenceMs),
    stream_type: S.realtime.streamType,
    return_timestamps: 'true', // start_s / end_s on finals → speaking time for words-per-minute
  });
  return `${S.realtime.url}?${qs}`;
}

/** Attach the relay to an http.Server at /api/live. */
export function attachLiveRelay(server, { enabled = () => true } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/api/live') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => relay(client, enabled()));
  });
  return wss;
}

async function relay(client, enabled) {
  const toClient = (msg) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(msg));
  let failed = false;
  const unavailable = (reason) => {
    if (failed) return;
    failed = true;
    toClient({ type: 'unavailable', reason });
    client.close(4001, 'unavailable');
  };
  if (!enabled) return unavailable('realtime disabled');

  let silenceMs = 1200;
  let ready = false;
  let closed = false;
  const upstream = new WebSocket(upstreamUrl({ silenceMs }), {
    agent: (await getProxyAgent(S.realtime.url)) || undefined,
    headers: { 'api-subscription-key': S.apiKey },
    handshakeTimeout: 5000,
  });
  const toSarvam = (msg) => upstream.readyState === WebSocket.OPEN && upstream.send(JSON.stringify(msg));

  upstream.on('unexpected-response', (_req, res) => {
    res.resume();
    console.warn(`[live] Sarvam realtime rejected the connection: HTTP ${res.statusCode}`);
    unavailable(`HTTP ${res.statusCode}`);
  });
  upstream.on('error', (e) => { if (!ready) unavailable(e.message); else console.warn('[live] upstream error', e.message); });
  upstream.on('close', (code, reason) => {
    if (closed) return;
    if (!ready) return unavailable(`closed ${code} ${reason}`);
    toClient({ type: 'closed', code, reason: String(reason) });
    client.close();
  });

  const ping = setInterval(() => toSarvam({ event: 'ping' }), 20_000);

  upstream.on('message', (raw) => {
    let e;
    try { e = JSON.parse(raw); } catch { return; }
    switch (e.event) {
      case 'session.begin':
        ready = true;
        return toClient({ type: 'ready', requestId: e.request_id, config: e.config });
      case 'vad.speech_start':
        return toClient({ type: 'speech_start', idx: e.utterance_idx });
      case 'transcript.partial':
        return toClient({ type: 'partial', idx: e.utterance_idx, text: e.text });
      case 'vad.speech_end':
        return toClient({ type: 'speech_end', idx: e.utterance_idx });
      case 'transcript.final':
        return toClient({
          type: 'final', idx: e.utterance_idx, text: e.text ?? '',
          language: e.language ?? null, languageConfidence: e.language_confidence ?? null,
          speechSec: e.end_s != null && e.start_s != null ? Math.max(0, e.end_s - e.start_s) : null,
        });
      case 'error':
        console.warn('[live] Sarvam error', e.code, e.message);
        return toClient({ type: 'error', code: e.code, fatal: !!e.is_fatal, message: e.message });
      default:
        return; // config.updated, pong, session.end: nothing to forward
    }
  });

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      // Raw PCM16 from the browser → base64 audio_input.
      return toSarvam({ event: 'audio_input', audio: Buffer.from(data).toString('base64') });
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'config' && Number.isFinite(m.silenceMs)) {
      silenceMs = Math.max(300, Math.min(5000, Math.round(m.silenceMs)));
      // VAD knobs apply immediately (no reconnect needed).
      toSarvam({ event: 'config.update', silence_duration_ms: silenceMs });
    } else if (m.type === 'finish') {
      // "Done speaking": endpointing=vad has no flush, so push enough silence to end the turn now.
      const pad = Buffer.alloc(Math.ceil(((silenceMs + 400) / 1000) * SAMPLE_RATE) * 2);
      for (let o = 0; o < pad.length; o += 6400) toSarvam({ event: 'audio_input', audio: pad.subarray(o, o + 6400).toString('base64') });
    }
  });

  client.on('close', () => {
    closed = true;
    clearInterval(ping);
    if (upstream.readyState === WebSocket.OPEN) { toSarvam({ event: 'end' }); upstream.close(); }
    else upstream.terminate();
  });
}
