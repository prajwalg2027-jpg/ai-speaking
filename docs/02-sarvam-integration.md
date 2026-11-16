# Sarvam AI integration

> **Last checked against Sarvam's docs: November 2026.** Model IDs are environment
> variables (`.env.example`), so future upgrades are config-only. Items marked ⚠️ were
> inconsistent across Sarvam's own pages. Confirm them with a real API call.

## 1. Model choices

| Job | Sarvam model | Endpoint | Why |
|---|---|---|---|
| Speech → text (user answers) | **Saaras v4** `saaras:v4`, `mode: "codemix"` | `POST /speech-to-text` | Sarvam's current default STT, covering 22 Indian languages plus Indian and global English. **`codemix` mode** writes English words in Latin script and Hindi words in Devanagari, so the transcript itself shows how much of the answer was English. That's the core signal for the placement test. Leave `language_code` unset to auto-detect. |
| Speech → English (Hindi answers) | **Saaras v4**, `mode: "translate"` | `POST /speech-to-text` | Gives the English meaning of a Hindi answer, so the bot can understand a beginner. This replaces the legacy `/speech-to-text-translate` endpoint (Saaras v2.5). |
| Text → speech (the bot's voice) | **Bulbul v4 Flash** `bulbul:v4-flash` | `POST /text-to-speech` · HTTP streaming | Sarvam's latest TTS, with under 250 ms to first audio. Voice: `ishita_enhi_companion` (female, **English + Hindi**, slow and expressive, which suits beginners) ⚠️ check this ID in the voice catalog. The old short voice names like `anushka` are **rejected** by v4 Flash. `speech_sample_rate: 24000`, `output_audio_codec: "wav"`, plus `pace` for slower repeats. |
| Reasoning / judging / replies | **Sarvam-30B** `sarvam-30b` | `POST /v1/chat/completions` (OpenAI-compatible) | `sarvam-m` has been **retired** and is now refused by the API. Sarvam-30B (64K context) is fast enough for each turn. Upgrade to `sarvam-105b` (128K) if judging quality needs it. `reasoning_effort` is always set explicitly: `low` for the judge, `none` for the quick acknowledgment and intent checks. Reasoning tokens use up the `max_tokens` budget, so the code adds headroom. ⚠️ Sarvam's pages disagree on the default effort and on which models v1 accepts. |
| Translate (fallback prompts) | `sarvam-translate:v1` / `mayura:v1` | `POST /translate` | Only for dynamic text. The Hindi prompts are written by hand and cached. |

Auth: header `api-subscription-key: $SARVAM_API_KEY`. The key lives **only on the
server**, and the browser talks to our `/api/*` proxy.

### What changed in the November 2026 refresh
| Before | Now | Why |
|---|---|---|
| `saarika:v2.5` + `language_code=unknown` | `saaras:v4` + `mode=codemix` | Saarika v2.x is superseded. One model with modes now covers transcribe, translate and code-mix. |
| `/speech-to-text-translate` with `saaras:v2.5` | `/speech-to-text` with `mode=translate` | The old endpoint is legacy. |
| `bulbul:v2`, speaker `anushka`, 22050 Hz | `bulbul:v4-flash`, `ishita_enhi_companion`, 24 kHz | v2 is legacy. Bulbul v3 reached end of life for voice agents on 10 Nov 2026. v4 Flash rejects the old voice names. |
| `sarvam-m` | `sarvam-30b` + explicit `reasoning_effort` | sarvam-m is no longer accepted. |
| Client energy VAD + REST STT | *(next step, §2.1)* Realtime STT `saaras:v3-realtime` over WebSocket with server-side VAD | Sarvam's recommended path for voice agents. |

## 2. Turn pipeline

```
 ┌─────────── Browser ───────────┐          ┌──────────── Node server ────────────┐        Sarvam
 │ mic → AudioWorklet/Analyser   │  WAV     │ /api/stt ──────────────────────────────────► Saaras v4 (mode=codemix)
 │   • energy VAD (end-of-turn)  │ ───────► │   ↳ if lang≠en: ─────────────────────────────► Saaras v4 (mode=translate)
 │   • barge-in: stop TTS        │          │ clarify.detect(transcript)  (regex, ~0ms)
 │ orb animates on mic/TTS level │          │   ↳ ambiguous → Sarvam-30B intent classify
 │                               │  JSON    │ scoring.features() + Sarvam-30B judge
 │ next prompt audio ◄───────────│ ◄─────── │ state machine picks next question/variant
 └───────────────────────────────┘          │ /api/tts ─────────────────────────────────► Bulbul v4 Flash (cached)
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
3. **Use the Realtime STT API for live captions** (see §2.1). Partial transcripts let
   users see their words appear as they speak.
4. **Stream TTS sentence by sentence** for dynamic (LLM-generated) replies, so the first
   sentence starts playing before the whole reply has been synthesised.
5. **Send WAV at 16 kHz mono.** The client downsamples before upload: smaller payloads,
   and the format STT handles best.

### 2.1 Next upgrade: Sarvam Realtime STT (recommended, not yet built)
Sarvam now offers a **Realtime** speech-to-text API for voice agents:
`wss://api.sarvam.ai/speech-to-text-realtime/ws`, model `saaras:v3-realtime` (or
`saaras:v4`). The older `/speech-to-text/ws` streaming endpoint is legacy. Moving the
listening loop to Realtime would:

- **Replace the browser energy VAD with server-side VAD** (`endpointing: "vad"`, with
  `threshold`, `silence_duration_ms`, `min_speech_duration_ms`). Per question, send
  `config.update` instead of reconnecting: Q4 gets a longer `silence_duration_ms` so a
  thinking pause doesn't end the turn.
- **Improve barge-in.** Stop TTS on the `vad.speech_start` event, not on the client's
  mic level, which echo can falsely trigger.
- **Show live captions** from `transcript.partial`, and finish on `transcript.final`.
  That also removes the upload step, because audio is already streamed.

How to build it: the browser streams 16 kHz PCM16 frames to a WebSocket on our server
(`/api/live`), which relays them to Sarvam with the API key attached. The key never
reaches the browser. The current REST flow stays as the fallback. ⚠️ Confirm the event
names and parameters in Sarvam's Realtime API reference before building.

Also consider **Bulbul HTTP streaming** for LLM-generated replies, so audio starts
playing while the rest is still being generated. Scripted prompts don't need it,
because they're cached.

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
2. **LLM fallback** for ambiguous short replies. Sarvam-30B classifies the reply as one of
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
SARVAM_STT_MODEL=saaras:v4
SARVAM_STT_MODE=codemix
SARVAM_STT_LANGUAGE=            # empty = auto-detect
SARVAM_TTS_MODEL=bulbul:v4-flash
SARVAM_TTS_SPEAKER=ishita_enhi_companion
SARVAM_TTS_SAMPLE_RATE=24000
SARVAM_LLM_MODEL=sarvam-30b
SARVAM_LLM_REASONING_EFFORT=low
```

LLM settings: `temperature: 0.2` and `reasoning_effort: low` for judging (consistent
scores). `temperature: 0.6` and `reasoning_effort: none` for the quick acknowledgment
(speed). Ask for JSON and **validate it**: on a parse failure, retry once, then fall
back to feature-only scoring.

## 5. Failure and degradation
- **Sarvam unavailable or no key** → the app runs in **demo mode**: browser Web Speech
  API for STT and TTS, plus heuristic scoring only. The UX stays testable without a key.
- **Timeouts:** STT 10 s, TTS 8 s, LLM 15 s, with a single retry on 5xx or 429 and
  backoff.
- **Every turn is logged** (transcript, features, LLM scores, chosen route) so the
  thresholds can be calibrated against human-rated samples later.
