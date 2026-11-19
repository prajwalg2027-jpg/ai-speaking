// Sarvam busy (429): the voice call waits and tries again instead of failing the learner's turn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let srv, hits = 0;
before(async () => {
  srv = createServer((req, res) => {
    hits++;
    if (hits <= 2) { res.writeHead(429, { 'retry-after': '0' }); return res.end('busy'); }
    res.writeHead(200, { 'content-type': 'audio/pcm' }); res.end(Buffer.alloc(4800));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.SARVAM_API_KEY = 'k';
  process.env.SARVAM_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

test('voice retries twice when Sarvam is busy, then plays', async () => {
  const { streamSpeech } = await import('../server/sarvam.js');
  let bytes = 0;
  const r = await streamSpeech('Retry me, please.', { lang: 'en-IN' }, (c) => { bytes += c.length; });
  assert.equal(hits, 3);
  assert.equal(bytes, 4800);
  assert.equal(r.cached, false);
});

test('retry waits follow Retry-After, capped at 5 s', async () => {
  const { retryWait } = await import('../server/sarvam.js');
  const res = (after) => ({ headers: new Headers(after == null ? {} : { 'retry-after': String(after) }) });
  assert.ok(retryWait(res(2), 0) >= 2000 && retryWait(res(2), 0) < 2400);
  assert.ok(retryWait(res(60), 0) <= 5300);
  assert.ok(retryWait(res(null), 1) >= 800 && retryWait(res(null), 1) < 1200);
});
