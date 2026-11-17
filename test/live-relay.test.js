import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMockRealtime } from './mock-sarvam-realtime.js';

let mock, server, base;

before(async () => {
  mock = await startMockRealtime({ transcribe: async () => 'My name is Priya and I teach.', requireKey: 'test-key' });
  // config.js reads env at import time, so set it before importing the server.
  process.env.SARVAM_API_KEY = 'test-key';
  process.env.SARVAM_REALTIME_URL = mock.url;
  delete process.env.HTTPS_PROXY;
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${server.address().port}/api/live`;
});
after(async () => { server.close(); await mock.close(); });

/** Connect like the browser does and collect relay events. */
function connect() {
  const ws = new WebSocket(base);
  const events = [];
  const waiters = [];
  ws.on('message', (m) => {
    const e = JSON.parse(m); events.push(e);
    for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
  });
  const waitFor = (type, ms = 3000) => new Promise((resolve, reject) => {
    const hit = events.find((e) => e.type === type);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}; got ${events.map((e) => e.type)}`)), ms);
    waiters.push({ pred: (e) => e.type === type, resolve: (e) => { clearTimeout(t); resolve(e); } });
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return { ws, events, waitFor, closed };
}

const tone = (sec, amp = 0.3) => {
  const n = Math.round(sec * 16000), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
  return b;
};
const silence = (sec) => Buffer.alloc(Math.round(sec * 16000) * 2);
const stream = async (ws, buf) => { for (let o = 0; o < buf.length; o += 3200) ws.send(buf.subarray(o, o + 3200), { binary: true }); };

test('relay opens Sarvam realtime with the right query and key, and maps events', async () => {
  const c = connect();
  const ready = await c.waitFor('ready');
  assert.equal(ready.config.turn_detection, 'vad');
  const conn = mock.state.connections.at(-1);
  assert.equal(conn.headers['api-subscription-key'], 'test-key');
  assert.deepEqual(
    { model: conn.query.model, language_code: conn.query.language_code, mode: conn.query.mode, encoding: conn.query.encoding, sample_rate: conn.query.sample_rate, endpointing: conn.query.endpointing, return_timestamps: conn.query.return_timestamps },
    { model: 'saaras:v4', language_code: 'auto', mode: 'codemix', encoding: 'linear16', sample_rate: '16000', endpointing: 'vad', return_timestamps: 'true' },
  );
  assert.ok(!JSON.stringify(c.events).includes('test-key'), 'key must never reach the browser');

  c.ws.send(JSON.stringify({ type: 'config', silenceMs: 800 }));
  await stream(c.ws, Buffer.concat([tone(1.2), silence(1.0)]));
  assert.equal((await c.waitFor('speech_start')).idx, 0);
  await c.waitFor('speech_end');
  const final = await c.waitFor('final');
  assert.equal(final.text, 'My name is Priya and I teach.');
  assert.equal(final.language, 'en-IN');
  assert.ok(Math.abs(final.speechSec - 1.2) < 0.15, `speechSec ${final.speechSec}`);
  assert.deepEqual(conn.configUpdates, [{ event: 'config.update', silence_duration_ms: 800 }]);
  // The relay narrates what it does for the browser's log panel, without exposing the key.
  const logs = c.events.filter((e) => e.type === 'log').map((e) => e.msg);
  assert.ok(logs.includes('Connecting to Sarvam Realtime'));
  assert.ok(logs.includes('Sent config.update'));
  assert.ok(logs.includes('Sarvam applied config.update'));
  assert.match(c.events.find((e) => e.msg === 'Connecting to Sarvam Realtime').data.url, /model=saaras%3Av4/);
  c.ws.close();
});

test('"finish" forces the end of a turn without waiting for real silence', async () => {
  const c = connect();
  await c.waitFor('ready');
  c.ws.send(JSON.stringify({ type: 'config', silenceMs: 1500 }));
  await stream(c.ws, tone(0.8));
  await c.waitFor('speech_start');
  c.ws.send(JSON.stringify({ type: 'finish' }));
  const final = await c.waitFor('final');
  assert.equal(final.text, 'My name is Priya and I teach.');
  c.ws.close();
});

test('lab relay: any valid realtime option reaches Sarvam, invalid ones are dropped and reported', async () => {
  const ws = new WebSocket(`${base.replace('/api/live', '/api/lab/live')}?model=saaras:v3-realtime&mode=verbatim&threshold=0.5&stream_type=warp&bogus=1&language_code=hi-IN`);
  const events = [];
  ws.on('message', (m) => events.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 300));
  const q = mock.state.connections.at(-1).query;
  assert.equal(q.model, 'saaras:v3-realtime');
  assert.equal(q.mode, 'verbatim');
  assert.equal(q.threshold, '0.5');
  assert.equal(q.language_code, 'hi-IN');
  assert.equal(q.stream_type, 'balanced', 'invalid value replaced by the default');
  assert.ok(!('bogus' in q));
  assert.deepEqual(events.find((e) => e.msg === 'Ignored options with invalid values').data.rejected.sort(), ['bogus', 'stream_type']);
  assert.ok(events.some((e) => e.type === 'sarvam' && e.event.event === 'session.begin'), 'raw Sarvam events reach the lab');
  // Only Sarvam's own control events pass through; 'end' finalises and closes the session.
  ws.send(JSON.stringify({ type: 'sarvam', event: { event: 'audio_input', audio: 'AAAA' } }));
  ws.send(JSON.stringify({ type: 'sarvam', event: { event: 'end' } }));
  await new Promise((r) => ws.on('close', r));
  assert.ok(events.some((e) => e.type === 'sarvam' && e.event.event === 'session.end'));
  assert.equal(mock.state.connections.at(-1).audioBytes, 0, 'JSON audio_input is not passed through');
});

test('the app path ignores lab-style options and passthrough', async () => {
  const c = connect();
  await c.waitFor('ready');
  assert.equal(mock.state.connections.at(-1).query.model, 'saaras:v4');
  c.ws.send(JSON.stringify({ type: 'sarvam', event: { event: 'end' } }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!c.events.some((e) => e.type === 'sarvam'), 'no raw events on the app path');
  c.ws.close();
});

test('rejected upstream → browser gets "unavailable" and the socket closes (the app shows an error)', async () => {
  mock.state.rejectNext = true;
  const c = connect();
  const e = await c.waitFor('unavailable');
  assert.match(e.reason, /403/);
  assert.ok(c.events.some((x) => x.type === 'log' && /rejected the connection: HTTP 403/.test(x.msg)), 'rejection is logged with its status');
  assert.equal(await c.closed, 4001);
});
