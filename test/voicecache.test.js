// Fixed voice lines are kept between server starts, so a restart doesn't pay Sarvam to generate them again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockRest } from './mock-sarvam-rest.js';

let mock, dir;
before(async () => {
  mock = await startMockRest();
  dir = await mkdtemp(join(tmpdir(), 'adam-voice-'));
  Object.assign(process.env, { SARVAM_API_KEY: 'k', SARVAM_BASE_URL: mock.url, VOICE_CACHE_DIR: dir });
});
after(() => mock.close());

const ttsCalls = () => mock.calls.filter((c) => c.path === '/text-to-speech/stream').length;
const LINES = [{ text: 'Okay.', lang: 'en-IN', pace: 1 }, { text: 'Got it.', lang: 'en-IN', pace: 1 }, { text: 'नमस्ते!', lang: 'hi-IN', pace: 1 }];

test('a restart loads the fixed lines from the store: no Sarvam calls', async () => {
  const first = await import('../server/sarvam.js?start=1');
  const r1 = await first.pregenerate(LINES, { gapMs: 0 });
  assert.deepEqual(r1, { done: 3, failed: 0, stored: 0 });
  assert.equal(ttsCalls(), 3);
  await new Promise((r) => setTimeout(r, 50)); // saving happens in the background
  assert.equal((await readdir(join(dir, 'voice'))).length, 3);

  const second = await import('../server/sarvam.js?start=2'); // a fresh server: empty memory
  const r2 = await second.pregenerate(LINES, { gapMs: 0 });
  assert.deepEqual(r2, { done: 3, failed: 0, stored: 3 });
  assert.equal(ttsCalls(), 3, 'no new Sarvam calls');
  let bytes = 0;
  await second.streamSpeech('Okay.', { lang: 'en-IN', pace: 1 }, (c) => { bytes += c.length; });
  assert.ok(bytes > 0, 'the stored clip plays');
});

test("lines the AI writes in a conversation are never stored (they may contain a learner's details)", async () => {
  const s = await import('../server/sarvam.js?start=3');
  await s.streamSpeech('Nice to meet you, Priya from Pune.', { lang: 'en-IN', pace: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readdir(join(dir, 'voice'))).length, 3);
});

test('a second listener joins a line that is being generated: one Sarvam call, the audio from its start', async () => {
  const s = await import('../server/sarvam.js?start=4');
  const before = ttsCalls();
  const heard = { first: 0, second: 0 };
  // Her reaction's voice is started early; the app asks for the same line a moment later.
  const early = s.streamSpeech('That sounds lovely, Asha.', { lang: 'en-IN', pace: 1 }, (c) => { heard.first += c.length; });
  await new Promise((r) => setTimeout(r, 5)); // the first half has arrived; the second comes 10 ms after it
  const joined = await s.streamSpeech('That sounds lovely, Asha.', { lang: 'en-IN', pace: 1 }, (c) => { heard.second += c.length; });
  await early;
  assert.deepEqual([heard.first, heard.second, joined.joined, joined.bytes], [9600, 9600, true, 9600]);
  assert.equal(ttsCalls() - before, 1, 'generated once');
  const again = await s.streamSpeech('That sounds lovely, Asha.', { lang: 'en-IN', pace: 1 });
  assert.equal(again.cached, true);
});

