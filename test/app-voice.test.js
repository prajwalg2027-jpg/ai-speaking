// Sakhi's voice in the app: a Google Gemini voice by default (admin settings, "voice"), Sarvam when Google isn't set
// up on the server, and Sarvam for a line the Google voice fails on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let srv, sarvamHits = 0;
const googleCalls = [];
let googleFails = false;
before(async () => {
  srv = createServer((req, res) => { sarvamHits++; res.writeHead(200, { 'content-type': 'audio/pcm' }); res.end(Buffer.alloc(4800)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.SARVAM_API_KEY = 'k';
  process.env.SARVAM_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  delete process.env.K_SERVICE; delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.CLOUD_TTS;
  const voices = await import('../server/voices/index.js');
  voices.setCloudTtsClient({
    streamingSynthesize() {
      const call = { writes: [] };
      googleCalls.push(call);
      return {
        write: (m) => call.writes.push(m), end: () => {},
        async *[Symbol.asyncIterator]() {
          if (googleFails) { const e = new Error('7 PERMISSION_DENIED'); e.details = 'Cloud Text-to-Speech API has not been used in project'; throw e; }
          yield { audioContent: Buffer.alloc(2400) }; yield { audioContent: Buffer.alloc(2400) };
        },
      };
    },
  });
});
after(() => srv.close());

test('the default voice is a Gemini voice through Google Cloud', async () => {
  const { SECTIONS } = await import('../server/settings.js');
  assert.deepEqual({ ...SECTIONS.voice.defaults, style: undefined }, { source: 'cloudtts', model: 'gemini-2.5-flash-tts', voice: 'Sulafat', style: undefined, fallbackToSarvam: true });
});

test('without Google sign-in on the server (a laptop), Sarvam speaks', async () => {
  const { streamSpeech, voiceInUse } = await import('../server/sarvam.js');
  assert.equal(voiceInUse().source, 'sarvam');
  await streamSpeech('Hello from a laptop.', { lang: 'en-IN' });
  assert.equal(sarvamHits, 1);
  assert.equal(googleCalls.length, 0);
});

test('on the deployed server, the Gemini voice speaks, streamed, and is cached', async () => {
  process.env.CLOUD_TTS = 'on';
  const { streamSpeech, voiceInUse } = await import('../server/sarvam.js');
  const { withLedger, makeLedger, summarize } = await import('../server/costs.js');
  assert.deepEqual([voiceInUse().source, voiceInUse().voice], ['cloudtts', 'Sulafat']);
  const ledger = makeLedger();
  let bytes = 0, pieces = 0;
  const r = await withLedger(ledger, () => streamSpeech('Nice to meet you!', { lang: 'en-IN', pace: 0.9 }, (c) => { bytes += c.length; pieces++; }));
  assert.equal(r.cached, false);
  assert.equal(bytes, 4800); assert.equal(pieces, 2, 'sent as it comes');
  assert.equal(sarvamHits, 1, 'Sarvam not called');
  const [cfg, input] = googleCalls[0].writes;
  assert.deepEqual(cfg.streamingConfig.voice, { name: 'Sulafat', languageCode: 'en-IN', modelName: 'gemini-2.5-flash-tts' });
  assert.equal(cfg.streamingConfig.streamingAudioConfig.speakingRate, undefined, 'the pace goes in words');
  assert.match(input.input.prompt, /slower/);
  const c = summarize(ledger).tts;
  assert.equal(c.googleCalls, 1); assert.ok(c.inr > 0); assert.equal(c.chars, 0);
  const again = await streamSpeech('Nice to meet you!', { lang: 'en-IN', pace: 0.9 });
  assert.equal(again.cached, true); assert.equal(googleCalls.length, 1);
});

test('a line the Gemini voice fails on is said by Sarvam, and Google is tried again next time', async () => {
  process.env.CLOUD_TTS = 'on';
  googleFails = true;
  const { streamSpeech } = await import('../server/sarvam.js');
  let bytes = 0;
  await streamSpeech('Shall we begin?', { lang: 'en-IN' }, (c) => { bytes += c.length; });
  assert.equal(bytes, 4800);
  assert.equal(sarvamHits, 2);
  const before = googleCalls.length;
  googleFails = false;
  await streamSpeech('Shall we begin?', { lang: 'en-IN' });
  assert.equal(googleCalls.length, before + 1, 'not cached in the wrong voice');
  delete process.env.CLOUD_TTS;
});
