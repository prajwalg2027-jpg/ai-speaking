# Sakhi: a voice-first AI English coach

When you open the app, a soft talking bubble greets you and runs a **4-question,
voice-only placement test**. It places you into one of four speaking levels:

| L1 Starter | L2 Word-builder | L3 Conversational | L4 Eloquent |
|---|---|---|---|
| Little or no English | Knows words, not fluent | Comfortable, some errors | Precise, complex, idiomatic |

The speech, voice and language AI is powered by **[Sarvam AI](https://www.sarvam.ai)**:
**Saaras v4 Realtime** (streaming speech-to-text with server-side turn detection),
**Bulbul v4 Flash** (voice) and **Sarvam-105B** (scoring and replies, reading Hindi directly).

## Design docs
- **[docs/03-conversation.md](docs/03-conversation.md)**: how the placement runs as a conversation with a
  tutor (follow-ups, memory, guardrails, streamed voice).
- **[docs/01-assessment-design.md](docs/01-assessment-design.md)**: how to measure
  speaking ability by voice, the 4 adaptive questions (open intro → picture/word
  vocabulary in both directions → read-aloud → opinion), and the scoring rubric.
- **[docs/02-sarvam-integration.md](docs/02-sarvam-integration.md)**: which Sarvam models
  are used and why, the turn pipeline, latency tactics, and **how misunderstandings are
  handled** in both directions.

## Website
The public landing page and privacy policy for **adamspeaks.in** live in [`website/`](website/README.md)
(static, hosted on Firebase Hosting in Google Cloud).

## Run it
```bash
npm install
cp .env.example .env     # add SARVAM_API_KEY (required)
npm start                # http://localhost:3000
npm test
```
Node ≥ 20. The only runtime dependency is `ws`, for the Realtime WebSocket. A Sarvam key is
required: without one the app explains what's missing (there is no demo or fallback mode).

**STT lab:** open `/stt-lab.html` to run one recording through many Sarvam speech-to-text configurations
in parallel (live streaming or one upload, every model/mode/language/VAD option, pause trimming, cost).

**Mic test:** open `/mic-test.html` to compare the phone's noise suppression and auto volume on vs
off (see `docs/backlog.md` for how to open it on an Android phone).

**Behind an HTTPS proxy?** Set `HTTPS_PROXY` and run with `NODE_USE_ENV_PROXY=1` for the
REST calls. The Realtime socket uses `https-proxy-agent` (an optional dependency)
automatically. Your proxy must allow WebSocket upgrades.

## Layout
```
shared/assessment.js          question bank: 4 questions × level variants, Hindi fallbacks
server/index.js               static + /api/session, /api/session/turn, /api/tts/stream, STT lab endpoints
server/session.js             the conversation: memory, next step, help ladder, summary
server/tutor.js               Sakhi's lines (Sarvam-105B) and their guardrails
server/turn.js                each reply: quick checks, understand (answer or not, name, facts), measure + judge
server/live.js                /api/live: browser ⇄ Sarvam Realtime STT relay (key stays server-side)
server/sarvam.js              Sarvam REST client: Bulbul v4 Flash (cached), chat (JSON mode), Saaras REST for the mic test
server/clarify.js             "didn't understand" detection (EN / Hinglish / Devanagari)
server/scoring.js             deterministic speech features + final level rules
server/costs.js               Sarvam cost ledger per conversation (₹), prices from .env
server/prompts.js             rubric and understand prompts
public/app.js                 conversation state machine
public/live.js                Realtime client: streams only while listening; utterances → answers
public/audio.js               mic capture, barge-in detection, TTS playback
public/log.js                 live log panel
public/cost.js                cost counter at the top (polls /api/session/cost)
public/mic-test.html          mic processing on/off test page
public/pcm.js                 streaming resampler → 16 kHz PCM16
test/mock-sarvam-realtime.js  protocol-accurate stand-in for Sarvam Realtime (tests / offline dev)
```

