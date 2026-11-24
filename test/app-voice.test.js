// Sakhi's voice in the app: a Google Gemini voice through Vertex AI by default (admin settings, "voice"), billed to
// Google Cloud; Sarvam when Google isn't set up on the server, and Sarvam for a line the Google voice fails on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let srv, vertex, sarvamHits = 0;
const vertexCalls = [];
let vertexFails = false;
const googleCalls = [];
let googleFails = false;
before(async () => {
  srv = createServer((req, res) => { sarvamHits++; res.writeHead(200, { 'content-type': 'audio/pcm' }); res.end(Buffer.alloc(4800)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  // Vertex AI's streamGenerateContent: the sound in two events, then what it counted.
  vertex = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    vertexCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    if (vertexFails) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Permission denied"}}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const audio = (n) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(n).toString('base64') } }] } }] })}\n\n`;
    res.write(audio(2400)); res.write(audio(2400));
    res.end(`data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } })}\n\n`);
  });
  await new Promise((r) => vertex.listen(0, '127.0.0.1', r));
  process.env.SARVAM_API_KEY = 'k';
  process.env.SARVAM_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  delete process.env.K_SERVICE; delete process.env.GOOGLE_APPLICATION_CREDENTIALS; delete process.env.CLOUD_TTS;
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI; delete process.env.GEMINI_API_KEY;
  (await import('../server/llm/openai.js')).setVertexTokenSource(() => 'vertex-token');
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
after(() => { srv.close(); vertex.close(); });

test('the default voice is Gemini 3.8 Flash-Lite TTS, through Vertex AI (Google Cloud)', async () => {
  const { SECTIONS } = await import('../server/settings.js');
  assert.deepEqual({ ...SECTIONS.voice.defaults, style: undefined }, { source: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'Sulafat', style: undefined, fallbackToSarvam: true });
});

test('without Google sign-in on the server (a laptop), Sarvam speaks', async () => {
  const { streamSpeech, voiceInUse } = await import('../server/sarvam.js');
  assert.equal(voiceInUse().source, 'sarvam');
  await streamSpeech('Hello from a laptop.', { lang: 'en-IN' });
  assert.equal(sarvamHits, 1);
  assert.equal(googleCalls.length, 0);
});

test('on the deployed server, Gemini 3.8 Flash-Lite speaks through Vertex AI, signed in to Google Cloud (no key)', async () => {
  process.env.CLOUD_TTS = 'on'; // stands for "signed in to Google Cloud"
  process.env.VERTEX_TTS_BASE_URL = `http://127.0.0.1:${vertex.address().port}/models`;
  const { streamSpeech, voiceInUse } = await import('../server/sarvam.js');
  const { withLedger, makeLedger, summarize } = await import('../server/costs.js');
  assert.deepEqual([voiceInUse().source, voiceInUse().model], ['gemini', 'gemini-3.8-flash-lite-tts']);
  const ledger = makeLedger();
  let bytes = 0, pieces = 0;
  await withLedger(ledger, () => streamSpeech('नमस्ते, मेरा नाम सखी है।', { lang: 'hi-IN', pace: 0.9 }, (c) => { bytes += c.length; pieces++; }));
  assert.equal(bytes, 4800); assert.equal(pieces, 2, 'sent as it comes');
  const call = vertexCalls[0];
  assert.equal(call.url, '/models/gemini-3.8-flash-lite-tts:streamGenerateContent?alt=sse');
  assert.equal(call.auth, 'Bearer vertex-token');
  assert.deepEqual(call.body.generationConfig, { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Sulafat' } }, languageCode: 'hi-IN' } });
  assert.match(call.body.contents[0].parts[0].text, /^Speak warmly.*slower than usual, clearly:\nनमस्ते/s);
  const c = summarize(ledger).tts;
  assert.equal(c.googleCalls, 1); assert.ok(c.inr > 0); assert.equal(c.chars, 0, 'no Sarvam characters');
  assert.equal(sarvamHits, 1, 'Sarvam not called (only by the laptop test)');
});

test('Vertex AI refusing: Sarvam says the line', async () => {
  vertexFails = true;
  const { streamSpeech } = await import('../server/sarvam.js');
  let bytes = 0;
  await streamSpeech('Vertex is down.', { lang: 'en-IN' }, (c) => { bytes += c.length; });
  assert.equal(bytes, 4800); assert.equal(sarvamHits, 2);
  vertexFails = false; sarvamHits = 1;
});

test('through Cloud Text-to-Speech (chosen in the settings), the Gemini voice speaks, streamed, and is cached', async () => {
  process.env.CLOUD_TTS = 'on';
  const settings = await import('../server/settings.js');
  await settings.set('voice', { ...settings.SECTIONS.voice.defaults, source: 'cloudtts', model: 'gemini-2.5-flash-tts' });
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
