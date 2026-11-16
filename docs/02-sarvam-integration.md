# Sarvam AI integration

> **Verify model IDs before shipping.** The model IDs below are based on Sarvam's public
> API as of this writing (I couldn't reach docs.sarvam.ai from the build environment).
> All of them are environment variables (`.env.example`), so upgrading to a newer
> version (e.g. a newer Bulbul or a larger Sarvam LLM) is a config change only.

## 1. Model choices

| Job | Sarvam model | Endpoint | Why |
|---|---|---|---|
| Speech → text (user answers) | **Saarika** `saarika:v2.5` | `POST /speech-to-text` (REST) · `wss://…/speech-to-text/ws` (streaming) | Built for Indian English and the 10+ Indic languages, and handles **code-mixed** Hinglish. With `language_code: "unknown"` it returns the **detected language**, which we use directly as an assessment signal. |
| Speech → English (Hindi answers) | **Saaras** `saaras:v2.5` | `POST /speech-to-text-translate` | When a beginner answers in Hindi, we still need to know *what they meant* to reply naturally and judge comprehension. |
| Text → speech (the bot's voice) | **Bulbul** `bulbul:v2` | `POST /text-to-speech` · streaming WS | Natural Indian-accent voices. Supports `pace`, which we lower to `0.8` when repeating for clarity, and `target_language_code` for Hindi fallback prompts. Speaker: `anushka` (warm, clear). |
| Reasoning / judging / replies | **Sarvam-M** `sarvam-m` | `POST /v1/chat/completions` (OpenAI-compatible) | Bilingual (Hindi + English). Scores answers against the rubric (JSON), classifies clarification intent when keywords miss, and writes short empathetic replies. |
| Translate (fallback prompts) | **Mayura** `mayura:v1` / `sarvam-translate:v1` | `POST /translate` | Pre-translating prompts into Hindi. In practice we **hand-author** the Hindi prompts and cache them, so this is only for dynamic text. |
| Language ID (text) | `POST /text-lid` | | A cheap check on a transcript when STT language ID is ambiguous. |

Auth: header `api-subscription-key: $SARVAM_API_KEY`. The key lives **only on the
server**, and the browser talks to our `/api/*` proxy.

## 2. Turn pipeline

```
 ┌─────────── Browser ───────────┐          ┌──────────── Node server ────────────┐        Sarvam
 │ mic → AudioWorklet/Analyser   │  WAV     │ /api/stt ──────────────────────────────────► Saarika (lang=unknown)
 │   • energy VAD (end-of-turn)  │ ───────► │   ↳ if lang≠en: ─────────────────────────────► Saaras (→ English meaning)
 │   • barge-in: stop TTS        │          │ clarify.detect(transcript)  (regex, ~0ms)
 │ orb animates on mic/TTS level │          │   ↳ ambiguous → Sarvam-M intent classify
 │                               │  JSON    │ scoring.features() + Sarvam-M judge (async)
 │ next prompt audio ◄───────────│ ◄─────── │ state machine picks next question/variant
 └───────────────────────────────┘          │ /api/tts ─────────────────────────────────► Bulbul (cached)
                                            └──────────────────────────────────────┘
```

### Making it feel instant
1. **Pre-synthesise every scripted prompt.** All 4 questions × 4 variants, plus the Hindi
   fallbacks and acknowledgments, are fixed text. They are rendered by Bulbul once, then
   cached in memory or on a CDN under a hash of `(text, speaker, pace, lang)`. Placement
   prompts then play with zero TTS latency.
2. **Score in the background.** When an answer ends, the server sends back the
   *acknowledgment + next prompt* as soon as STT and the clarification check finish
   (about 300–700 ms). The LLM judge runs in parallel, and its result is only needed
   for routing after Q1 and for the final result.
3. **Use streaming STT for the live transcript.** The Saarika WebSocket gives partial
   transcripts, so the user sees their words appear, which reassures them that they're
   being heard. The REST call in this repo is the simple baseline. Switch to the WS
   once you need live captions.
4. **Stream TTS sentence by sentence** for dynamic (LLM-generated) replies, so the first
   sentence starts playing before the whole reply has been synthesised.
5. **Send WAV at 16 kHz mono.** The client downsamples before upload: smaller payloads,
   and the format STT handles best.

### End-of-turn detection
- An energy-based VAD on the client tracks a calibrated noise floor (measured during the
  first 500 ms). The turn ends after **1.2 s of silence** following speech. For Q4
  (opinion) it's **1.8 s**, because thinking pauses are normal there and cutting
  someone off mid-thought would hurt their score.
- Hard cap of 45 s per answer. There is also a **tap-to-finish** button, because VAD
  is never perfect.
- **Barge-in:** if the user starts speaking while the bot is talking, TTS playback stops
  immediately.

## 3. Handling misunderstanding and unclear communication

This is the part that makes or breaks a voice-first app for beginners. There are two
directions: **the user didn't understand us**, and **we didn't understand the user**.

### A. The user didn't understand the bot
Detected by `server/clarify.js` in two layers:

1. **Fast lexical match** (Hindi, Hinglish and English): *"what?", "sorry?", "repeat",
   "again", "pardon", "samajh nahi aaya", "kya?", "phir se bolo", "Hindi mein bolo",
   "slowly", "dheere"*, and their Devanagari forms.
2. **LLM fallback** for ambiguous short replies. Sarvam-M classifies the reply as one of
   `{answer, repeat, slower, in_hindi, dont_know, off_topic}`.

**Escalation ladder** (each step is used once per question):

| Attempt | Bot does | Counted as |
|---|---|---|
| 1st confusion | Repeats the prompt **slower** (Bulbul `pace: 0.8`) and shows it as text on screen | neutral |
| 2nd confusion | **Rephrases more simply**, then gives the **Hindi version** | `needed_hindi = true` (comprehension signal) |
| 3rd confusion / "I don't know" | *"No problem at all! Let's try another one."* Moves on | the item scores 0, without penalising other dimensions |

An explicit *"Hindi mein bolo"* jumps straight to the Hindi version. Respecting the
request matters more than the assessment purity.

### B. The bot didn't understand the user
| Situation | How it's detected | Response |
|---|---|---|
| **Silence** | VAD sees no speech for 6 s | An on-screen nudge: *"Take your time. Whenever you're ready."* At 12 s, the bot speaks the Hindi version. A second 12 s silence moves on. |
| **Empty or garbled transcript** | Transcript < 2 chars, or STT returns nothing, or very low energy | *"Sorry, I couldn't hear that clearly. Could you say it again, a little closer to the phone?"* Doesn't count as an attempt. |
| **Too much noise** | Noise floor above threshold during calibration | A banner suggests a quieter spot. Raises VAD threshold. |
| **Answer in Hindi** | `language_code = hi-IN` or Devanagari ratio > 0.5 | Treated as valid **data**, never as an error. Saaras gives the meaning, so the bot can respond warmly: *"Nice to meet you, Ravi!"* |
| **Off-topic answer** | LLM relevance score low | It could be a comprehension issue, so the bot asks once in a different way rather than moving on. |
| **Truncated answer** (VAD cut them off) | Answer ends mid-sentence (no final punctuation from STT and a short duration) | *"Sorry, did I cut you off? Please go on."* The next recording is **appended** to the same answer. |
| **Low-confidence key info** (e.g. their name) | It's the user's name | Read it back: *"Did I get that right, Ravi?"* A "no" reopens the mic. |

### C. Transparency principles
- **Show what we heard.** The live transcript stays under the orb, so users can see
  recognition errors instead of feeling judged by them.
- **Never correct during placement.** Mistakes are signal. Teaching starts after
  placement.
- **Always offer an exit.** "Skip" and "Speak Hindi" chips are always visible.

## 4. Configuration (see `.env.example`)

```ini
SARVAM_API_KEY=...
SARVAM_BASE_URL=https://api.sarvam.ai
SARVAM_STT_MODEL=saarika:v2.5
SARVAM_STT_TRANSLATE_MODEL=saaras:v2.5
SARVAM_TTS_MODEL=bulbul:v2
SARVAM_TTS_SPEAKER=anushka
SARVAM_LLM_MODEL=sarvam-m
```

LLM settings: `temperature: 0.2` for judging (consistency), `0.6` for conversational
replies. Ask for JSON and **validate it**: on a parse failure, retry once, then fall back
to feature-only scoring.

## 5. Failure and degradation
- **Sarvam unavailable or no key** → the app runs in **demo mode**: browser Web Speech
  API for STT and TTS, plus heuristic scoring only. The UX stays testable without a key.
- **Timeouts:** STT 10 s, TTS 8 s, LLM 15 s, with a single retry on 5xx or 429 and
  backoff.
- **Every turn is logged** (transcript, features, LLM scores, chosen route) so the
  thresholds can be calibrated against human-rated samples later.
