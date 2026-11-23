// Comparing voices (admin console › Compare voices, server/admin/voices.js): Sarvam's and Google's, on the same
// words, with timings and costs. Against stand-ins for both providers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startMockRest } from './mock-sarvam-rest.js';

let server, base, mock, google;
const googleCalls = [];
before(async () => {
  mock = await startMockRest();
  // A stand-in for Google's Interactions API: streamed sound (server-sent events), and its own count of tokens.
  google = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    googleCalls.push({ path: req.url, key: req.headers['x-goog-api-key'], body: raw ? JSON.parse(raw) : null });
    if (req.url.startsWith('/v1beta/voices')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voices: [{ name: 'voices/aanya-in', display_name: 'Aanya', gender: 'female', accent: 'Indian' }] })); }
    const b = JSON.parse(raw);
    if (b.model === 'gemini-broken') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Unknown voice' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const second = Buffer.alloc(48000).toString('base64'); // one second of 24 kHz, 16-bit sound
    const events = [{ event_type: 'interaction.start' }, { event_type: 'step.delta', delta: { type: 'audio', data: second } }, { event_type: 'step.delta', delta: { type: 'audio', data: second } },
      { event_type: 'interaction.complete', interaction: { usage: { total_input_tokens: 20, total_output_tokens: 50 } } }];
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
  await new Promise((ok) => google.listen(0, '127.0.0.1', ok));
  Object.assign(process.env, { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: mock.url, GEMINI_API_KEY: 'gemini-test-key', GEMINI_NATIVE_BASE_URL: `http://127.0.0.1:${google.address().port}/v1beta`, USD_INR: '88' });
  delete process.env.DATABASE_URL;
  ({ server } = await import('../server/index.js'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); google.close(); });
const get = async (path) => (await fetch(`${base}${path}`)).json();
const speak = async (body) => { const r = await fetch(`${base}/api/admin/voices/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const ttsCalls = () => mock.calls.filter((c) => c.path === '/text-to-speech/stream');

test('the voices to choose from, and what each model costs', async () => {
  const info = await get('/api/admin/voices');
  assert.deepEqual([info.providers.sarvam.configured, info.providers.gemini.configured], [true, true]);
  assert.ok(info.voices.sarvam['bulbul:v4-flash'].length > 200 && info.voices.sarvam['bulbul:v4-flash'].includes('roopa_hi_companion'));
  assert.equal(info.voices.sarvam['bulbul:v3'].length, 37);
  // Google's 30 studio voices, and its wider library when the key can ask for it.
  assert.ok(info.voices.gemini.some((v) => v.id === 'Sulafat' && /Warm/.test(v.label)));
  assert.ok(info.voices.gemini.some((v) => v.id === 'aanya-in' && /Aanya \(female, Indian\)/.test(v.label)));
  assert.deepEqual(info.current, { provider: 'sarvam', model: 'bulbul:v4-flash', voice: 'roopa_hi_companion' });
  const row = (model) => info.prices.rows.find((r) => r.model === model);
  assert.equal(row('bulbul:v4-flash').per1000Chars, 2, '₹2 for 1,000 characters');
  assert.equal(row('bulbul:v3').per1000Chars, 3);
  // Google: $9 per million sound tokens, 25 a second: about ₹1.19 a minute of sound, plus a little for the text.
  const flash = row('gemini-3.8-flash-tts');
  assert.ok(Math.abs(flash.perMinute - ((9 / 1e6) * 25 * 60 * 88 + (0.5 / 1e6) * (1000 / 4) * 88 * (20 * 60 / 1000))) < 1e-9);
  assert.equal(flash.rises.from, '2027-01-01');
  assert.ok(info.samples.length >= 5 && info.modes.map((m) => m[0]).join() === 'app,one,sentences');
});

test("Sarvam: the same words as one request, as the app sends them, or sentence by sentence; with Sarvam's controls", async () => {
  const text = "Nice to meet you, Prajwal! | There's a picture on your screen. What is it called in English? आप इसे क्या कहेंगे?";
  let before = ttsCalls().length;
  let r = await speak({ provider: 'sarvam', model: 'bulbul:v4-flash', voice: 'ishita_enhi_companion', text, mode: 'one', pace: 0.9, pitch: 0.1, temperature: 0.3 });
  assert.equal(r.status, 200);
  assert.equal(ttsCalls().length - before, 1, 'one request');
  assert.deepEqual(JSON.parse(ttsCalls().at(-1).body), {
    text: "Nice to meet you, Prajwal! There's a picture on your screen. What is it called in English? आप इसे क्या कहेंगे?", language_code: 'hi-IN',
    speaker: 'ishita_enhi_companion', model: 'bulbul:v4-flash', speech_sample_rate: 24000, output_audio_codec: 'linear16', pace: 0.9, pitch: 0.1, temperature: 0.3,
  }, 'the voice, model and controls chosen; Hindi, since the text has some');
  const wav = Buffer.from(r.json.audio, 'base64');
  assert.deepEqual([wav.subarray(0, 4).toString(), wav.readUInt32LE(24), r.json.sampleRate], ['RIFF', 24000, 24000]);
  assert.equal(r.json.pieces.length, 1);
  assert.equal(r.json.chars, r.json.pieces[0].text.length);
  assert.ok(Math.abs(r.json.costInr - r.json.chars * 0.002) < 1e-12, '₹2 for 1,000 characters');
  assert.ok(r.json.firstAudioMs >= 0 && r.json.totalMs >= r.json.firstAudioMs && r.json.seconds > 0);

  before = ttsCalls().length;
  r = await speak({ provider: 'sarvam', model: 'bulbul:v4-flash', voice: 'roopa_hi_companion', text, mode: 'app' });
  assert.deepEqual(r.json.pieces.map((p) => p.text), ['Nice to meet you, Prajwal!', "There's a picture on your screen. What is it called in English?", 'आप इसे क्या कहेंगे?'], 'her reaction, her question, then the Hindi');
  assert.equal(ttsCalls().length - before, 3);
  assert.deepEqual(ttsCalls().slice(-3).map((c) => JSON.parse(c.body).language_code), ['en-IN', 'en-IN', 'hi-IN'], 'each piece in its own language');
  r = await speak({ provider: 'sarvam', model: 'bulbul:v3', voice: 'anushka', text: 'One. Two. Three.', mode: 'sentences' });
  assert.deepEqual([r.json.pieces.length, Math.abs(r.json.costInr - 'One.Two.Three.'.length * 0.003) < 1e-12], [3, true], 'Bulbul v3 at ₹3 for 1,000');
});

test('Sarvam is sent exactly the voice, model, language and controls chosen', async () => {
  const { piecesOf, sarvamLanguage } = await import('../server/voices/index.js');
  assert.deepEqual(piecesOf('A. B? | C! नमस्ते।', 'app'), ['A. B?', 'C!', 'नमस्ते।']);
  assert.deepEqual(piecesOf('A. B? | C!', 'one'), ['A. B? C!']);
  assert.deepEqual(piecesOf('A. B? | C!', 'sentences'), ['A.', 'B?', 'C!']);
  assert.deepEqual([sarvamLanguage('Hello there.'), sarvamLanguage('Hello. नमस्ते।')], ['en-IN', 'hi-IN']);
});

test("Google: the voice, the model and the style are sent as Google asks; its own token count sets the cost", async () => {
  googleCalls.length = 0;
  const r = await speak({ provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Sulafat', style: 'warm and friendly', text: 'Nice to meet you! | What is this?', mode: 'one' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const call = googleCalls.find((c) => c.path === '/v1beta/interactions');
  assert.equal(call.key, 'gemini-test-key');
  assert.deepEqual(call.body, {
    model: 'gemini-3.8-flash-tts',
    input: [{ type: 'user_input', content: [{ type: 'text', text: 'Nice to meet you! What is this?', annotations: [{ type: 'speech_metadata', style: 'warm and friendly' }] }] }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: 'Sulafat' }] },
    stream: true,
  });
  assert.equal(r.json.seconds, 2, 'two seconds of sound, from the streamed pieces');
  assert.deepEqual(r.json.pieces[0].tokens, { input: 20, output: 50, counted: true });
  assert.ok(Math.abs(r.json.costInr - ((20 * 0.5 + 50 * 9) / 1e6) * 88) < 1e-12);
  // Without a style nothing extra is sent; an error from Google is shown as it came.
  await speak({ provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'Achird', text: 'Hello.', mode: 'one' });
  assert.equal('annotations' in googleCalls.at(-1).body.input[0].content[0], false);
  const bad = await speak({ provider: 'gemini', model: 'gemini-broken', voice: 'Nobody', text: 'Hello.' });
  assert.deepEqual([bad.status, /Google 400: .*Unknown voice/.test(bad.json.reason)], [502, true]);
});

test('what is refused', async () => {
  assert.equal((await speak({ provider: 'elevenlabs', model: 'x', voice: 'y', text: 'Hi' })).status, 400);
  assert.equal((await speak({ provider: 'sarvam', model: 'bulbul:v4-flash', voice: 'roopa_hi_companion', text: 'x'.repeat(1300) })).status, 400, 'too long');
  assert.equal((await speak({ provider: 'sarvam', model: 'whisper', voice: 'roopa_hi_companion', text: 'Hi' })).status, 400, 'not a voice model');
  const key = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const r = await speak({ provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Kore', text: 'Hi' });
    assert.deepEqual([r.status, /No Gemini key on the server/.test(r.json.error)], [400, true]);
  } finally { process.env.GEMINI_API_KEY = key; }
});
