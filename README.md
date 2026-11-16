# Sakhi: a voice-first AI English coach

When you open the app, a soft talking bubble greets you and runs a **4-question,
voice-only placement test**. It places you into one of four speaking levels:

| L1 Starter | L2 Word-builder | L3 Conversational | L4 Eloquent |
|---|---|---|---|
| Little or no English | Knows words, not fluent | Comfortable, some errors | Precise, complex, idiomatic |

The speech, voice and language AI is powered by **[Sarvam AI](https://www.sarvam.ai)**:
Saarika (speech-to-text), Saaras (speech-to-English), Bulbul (voice) and Sarvam-M (LLM).

## Design docs
- **[docs/01-assessment-design.md](docs/01-assessment-design.md)**: how to measure
  speaking ability by voice, the 4 adaptive questions (open intro → picture/word
  vocabulary in both directions → read-aloud → opinion), and the scoring rubric.
- **[docs/02-sarvam-integration.md](docs/02-sarvam-integration.md)**: which Sarvam models
  are used and why, the turn pipeline, latency tactics, and **how misunderstandings are
  handled** in both directions.

## Run it
```bash
cp .env.example .env     # add SARVAM_API_KEY (leave blank for demo mode)
npm start                # http://localhost:3000
npm test
```
No dependencies (Node ≥ 20). Without a key, the app runs in **demo mode** using the
browser's built-in speech (works best in Chrome).

## Layout
```
shared/assessment.js   question bank: 4 questions × level variants, Hindi fallbacks
server/index.js        static + /api/turn, /api/tts, /api/final
server/sarvam.js       Sarvam client (STT, STT-translate, TTS w/ cache, chat + JSON)
server/clarify.js      "didn't understand" detection (EN / Hinglish / Devanagari)
server/scoring.js      deterministic speech features + final level rules
server/prompts.js      Sarvam-M rubric / intent / reply prompts
public/                orb UI, mic capture + VAD + WAV encoding, conversation state machine
```
