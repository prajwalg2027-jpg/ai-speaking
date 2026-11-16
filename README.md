# Sakhi: a voice-first AI English coach

When you open the app, a soft talking bubble greets you and runs a **4-question,
voice-only placement test**. It places you into one of four speaking levels:

| L1 Starter | L2 Word-builder | L3 Conversational | L4 Eloquent |
|---|---|---|---|
| Little or no English | Knows words, not fluent | Comfortable, some errors | Precise, complex, idiomatic |

The speech, voice and language AI is powered by **[Sarvam AI](https://www.sarvam.ai)**:
**Saaras v4 Realtime** (streaming speech-to-text with server-side turn detection, falling back to
REST), **Bulbul v4 Flash** (voice), **Sarvam-105B** (scoring) and **Mayura** (Hindi → English).

## Design docs
- **[docs/01-assessment-design.md](docs/01-assessment-design.md)**: how to measure
  speaking ability by voice, the 4 adaptive questions (open intro → picture/word
  vocabulary in both directions → read-aloud → opinion), and the scoring rubric.
- **[docs/02-sarvam-integration.md](docs/02-sarvam-integration.md)**: which Sarvam models
  are used and why, the turn pipeline, latency tactics, and **how misunderstandings are
  handled** in both directions.

## Run it
```bash
npm install
cp .env.example .env     # add SARVAM_API_KEY (leave blank for demo mode)
npm start                # http://localhost:3000
npm test
```
Node ≥ 20. The only runtime dependency is `ws`, for the Realtime WebSocket. Without a key,
the app runs in **demo mode** using the browser's built-in speech (works best in Chrome).

**Behind an HTTPS proxy?** Set `HTTPS_PROXY` and run with `NODE_USE_ENV_PROXY=1` for the
REST calls. The Realtime socket uses `https-proxy-agent` (an optional dependency)
automatically. If your proxy blocks WebSocket upgrades, the app falls back to REST on
its own.

## Layout
```
shared/assessment.js          question bank: 4 questions × level variants, Hindi fallbacks
server/index.js               static + /api/turn, /api/tts, /api/final; evaluateTurn()
server/live.js                /api/live: browser ⇄ Sarvam Realtime STT relay (key stays server-side)
server/sarvam.js              Sarvam REST client: Saaras v4, Bulbul v4 Flash (cached), chat (JSON mode), translate
server/clarify.js             "didn't understand" detection (EN / Hinglish / Devanagari)
server/scoring.js             deterministic speech features + final level rules
server/prompts.js             rubric / intent / reply prompts
public/app.js                 conversation state machine (realtime first, REST fallback)
public/live.js                Realtime client: utterances → answers, captions, barge-in
public/audio.js               mic, energy VAD (fallback), WAV encoding, TTS playback
public/pcm.js                 streaming resampler → 16 kHz PCM16
test/mock-sarvam-realtime.js  protocol-accurate stand-in for Sarvam Realtime (tests / offline dev)
```
