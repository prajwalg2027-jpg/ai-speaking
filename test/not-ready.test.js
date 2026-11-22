import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

let server, base;
before(async () => {
  delete process.env.SARVAM_API_KEY; // no key: the app must say so, not fall back to anything
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('without a key the server explains itself and refuses work', async () => {
  const cfg = await (await fetch(`http://${base}/api/config`)).json();
  assert.equal(cfg.ready, false);
  assert.match(cfg.reason, /SARVAM_API_KEY/);
  for (const path of ['/api/session', '/api/session/turn', '/api/tts/stream']) {
    const t = await fetch(`http://${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
    assert.equal(t.status, 503, path);
  }
  const msg = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/api/live`);
    ws.on('message', (m) => { resolve(JSON.parse(m)); ws.close(); });
  });
  assert.equal(msg.type, 'unavailable');
  assert.match(msg.reason, /SARVAM_API_KEY/);
});
