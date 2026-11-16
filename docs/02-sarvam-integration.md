# Sarvam AI integration

> **Verified on 16 Nov 2026** against Sarvam's current SDK (`sarvamai` 1.1.19, published
> 13 Nov 2026) and **live calls with a real API key**. Every REST call below was tested.
> The one exception is the Realtime WebSocket: the build sandbox's network proxy can't
> carry WebSocket upgrades, so that path was tested against a protocol-accurate local
> stand-in (see §2.1). Model IDs are environment variables (`.env.example`).

## 1. Model choices

| Job | Sarvam model | Endpoint | Why |
|---|---|---|---|
| **Live speech → text** (primary) | **Saaras v4** `saaras:v4`, `mode=codemix`, `language_code=auto` | `wss://api.sarvam.ai/speech-to-text-realtime/ws` | Sarvam's Realtime STT for voice agents. **Server-side VAD** decides when the user has finished, **partial transcripts** drive live captions, and `vad.speech_start` drives barge-in. Audio streams while the user speaks, so there's no upload step at the end. Details in §2.1. |
| Speech → text (fallback) | **Saaras v4**, `mode=codemix` | `POST /speech-to-text` | Used automatically when the Realtime socket can't open. The `language_code` field is omitted, so the API auto-detects and returns `language_code` + `language_probability`. ✅ Tested: English → `en-IN` (0.99). Hinglish → `"मेरा नाम Raju है। मैं shop में काम करता हूँ and I like cricket."` (`hi-IN`). |
| **Why codemix matters** | | | It writes English words in Latin script and Hindi words in Devanagari, so the transcript *itself* shows how much of the answer was English. That's the core signal for the placement test. |
| Hindi answer → English meaning | **Saaras v4** `mode=translate` (REST path) · **Mayura** `mayura:v1` text translate (live path) | `POST /speech-to-text` · `POST /translate` | Lets the bot understand a beginner. Replaces the legacy `/speech-to-text-translate`. ✅ Both tested: *"My name is Raju. I work in a shop and I like cricket."* |
| Text → speech (the bot's voice) | **Bulbul v4 Flash** `bulbul:v4-flash` | `POST /text-to-speech` | Field names: `text`, **`language_code`** (not `target_language_code`), `speaker`, `pace` (0.5–2.0), `speech_sample_rate`, `output_audio_codec: "wav"`. Voice: **`ishita_enhi_companion`** (female, English + Hindi). ✅ It's in the SDK's voice catalog and synthesises both languages. Old short names like `anushka` are rejected. |
| Scoring / intent | **Sarvam-105B** `sarvam-105b` | `POST /v1/chat/completions` | ✅ Tested: `sarvam-m` and `sarvam-30b` now return **400**. v1 accepts only `sarvam-105b` and `sarvam-105b-conversations`. Uses `reasoning_effort: "low"` (✅ about 0.4 s). `"none"` returns **400** on Sarvam models. `response_format: {type: "json_object"}` guarantees parseable rubric output. |
| Spoken acknowledgments | **Sarvam-105B Conversations** `sarvam-105b-conversations` | same | The variant Sarvam tuned for real-time dialogue and voice agents. ✅ e.g. *"Lovely, Priya. Walking with friends sounds wonderful."* |

Auth: header `api-subscription-key`. The key lives **only on the server**. The browser
talks to `/api/*` and `/api/live`, never to Sarvam directly.

### What changed in the November 2026 refresh
| Before | Now | Why |
|---|---|---|
| Client energy VAD + upload WAV after each answer | **Realtime STT** over WebSocket with server VAD, partials and barge-in. REST is the automatic fallback. | Sarvam's recommended path for voice agents. The legacy `/speech-to-text/ws` is superseded. |
| `saarika:v2.5` + `language_code=unknown` | `saaras:v4` + `mode=codemix` | Saarika v2.x is superseded. One model with modes now covers transcribe, translate and code-mix. |
| `/speech-to-text-translate` (`saaras:v2.5`) | `/speech-to-text` `mode=translate`, or `/translate` (Mayura) for text | The old endpoint is legacy. |
| `bulbul:v2`, `anushka`, `target_language_code`, 22050 Hz | `bulbul:v4-flash`, `ishita_enhi_companion`, `language_code`, 24 kHz | v2 is legacy. Bulbul v3 reached end of life for voice agents on 10 Nov 2026. v4 Flash rejects the old voice names. |
| `sarvam-m` | `sarvam-105b` / `sarvam-105b-conversations`, `reasoning_effort: low`, JSON mode | sarvam-m (and sarvam-30b) return 400. |

## 2. Turn pipeline

```
 ┌──────────── Browser ────────────┐            ┌───────────── Node server ─────────────┐         Sarvam
 │ mic (AEC/NS/AGC on)             │ PCM16 16k  │ /api/live relay (adds API key)          │ wss
 │  → resampler (pcm.js)           │ ─────────► │   binary → {event:"audio_input",…} ───────────► Realtime STT
 │ live.js: answer = utterances    │ ◄───────── │ ◄── session.begin, vad.speech_start,   ◄─────── saaras:v4
 │  until VAD silence + 700 ms     │  events    │     transcript.partial/final, …            (server VAD,
 │  • captions from partials       │            │   {type:"config"} → config.update             codemix)
 │  • barge-in on speech_start     │            │   {type:"finish"} → silence push
 │                                 │  JSON      │ /api/turn {transcript,languageCode}
 │                                 │ ─────────► │   ↳ Devanagari? → /translate ──────────────────► Mayura
 │                                 │            │   clarify.detect() → (short & ambiguous) ───────► sarvam-105b
 │                                 │            │   features() + rubric judge (JSON mode) ────────► sarvam-105b
 │ next prompt audio ◄─────────────│ ◄───────── │   + acknowledgment (Q1) ────────────────────────► sarvam-105b-conversations
 │                                 │            │ /api/tts (cached by text/voice/pace) ───────────► bulbul:v4-flash
 └─────────────────────────────────┘            └─────────────────────────────────────────┘
   Fallback (socket can't open / drops): client energy VAD → WAV → /api/turn → Saaras v4 REST
```

### Making it feel instant
1. **Pre-synthesise every scripted prompt.** All 4 questions × 4 variants, plus the Hindi
   fallbacks and acknowledgments, are fixed text. Bulbul renders them once, and the
   server caches them by `(text, voice, pace, language)`.
2. **Stream the answer while it's spoken.** With Realtime STT the transcript is ready
   when VAD ends the turn. Nothing is uploaded or transcribed after the user stops.
3. **Keep the LLM fast.** `reasoning_effort: "low"` plus JSON mode keeps scoring and
   intent calls to about 0.4 s each. The judge and the acknowledgment run in parallel.
4. **Next step:** Bulbul HTTP streaming (`/text-to-speech/stream`) for LLM-generated
   replies, so audio starts playing while the rest is still being synthesised.

### 2.1 Realtime STT: how it's built (`server/live.js`, `public/live.js`)
**Connection.** On first tap, the browser opens `/api/live`. The server opens
`wss://api.sarvam.ai/speech-to-text-realtime/ws?model=saaras:v4&language_code=auto&mode=codemix&encoding=linear16&sample_rate=16000&endpointing=vad&silence_duration_ms=…&stream_type=balanced&return_timestamps=true`
with the `api-subscription-key` header. When Sarvam sends `session.begin`, the browser
gets `ready` and starts streaming mic audio. Audio is resampled to 16 kHz PCM16 in the
browser and sent as binary frames. The server wraps each frame as
`{event:"audio_input", audio:<base64>}`.

**Per-question tuning without reconnecting.** Before each answer the browser sends
`{type:"config", silenceMs}`, and the relay forwards it as
`{event:"config.update", silence_duration_ms}`, which applies immediately. Q4 gets
1.8 s, so a thinking pause doesn't end the turn.

**One answer = one or more utterances.** Learners pause mid-sentence. After each
`transcript.final`, the client waits 700 ms. If VAD reports new speech, it keeps
collecting. Speaking time for words-per-minute comes from `end_s - start_s`
(`return_timestamps=true`).

**Echo vs. barge-in.** The mic keeps streaming while the bot talks.
- While the bot is playing, a `vad.speech_start` counts **only if the local mic level
  is also clearly above the noise floor**. Then it's a real barge-in: playback stops,
  and that utterance becomes the answer.
- Otherwise it's echo of the bot's own voice, and that utterance is ignored.
- Utterances that start while the bot is silent always count.

**"Done speaking" button.** With `endpointing=vad`, Sarvam has no `flush` (that's for
manual mode), so the relay pushes `silence_duration_ms` + 400 ms of silence, which
makes VAD close the turn immediately.

**Fallback.** These all make the browser switch to the REST path for the rest of the
session, with no user-visible error:
- The socket can't open (HTTP error, close code `1003`/`4000`, or a 6 s timeout).
- The socket drops mid-session.
- Sarvam sends a fatal `error`.

**Testing.** `test/mock-sarvam-realtime.js` is a stand-in that speaks the SDK's protocol
(query params, `session.begin`, VAD events, partials, timestamped finals,
`config.update`, rejection). `npm test` covers query/key forwarding (the key never
reaches the browser), event mapping, `config.update`, the `finish` silence push, and
rejection → `unavailable`.

A headless-Chromium run drove all four questions through the live path. The stand-in
transcribed each utterance with real Saaras v4. Results: correct transcripts, the
clarification ladder, the read-aloud ceiling probe, **barge-in in 0.2 s**, and a
final placement of Level 3 for a Level-3 speaker.

The same run against real Sarvam (where this sandbox blocks the socket) fell back to
REST automatically and produced the same placement.

> **Before production:** run once from a normal network, where WebSockets reach
> Sarvam, and check the server log shows no `[live] … rejected` line.

### End-of-turn detection
- **Realtime (primary):** Sarvam's server VAD, `silence_duration_ms` per question
  (1.2–1.8 s), plus the 700 ms grace period above.
- **REST fallback:** client energy VAD with a **continuous noise-floor estimate**. It
  drops fast in quiet, rises very slowly, and is capped. An earlier version measured
  the first 500 ms of each answer as "noise", so someone who answered instantly was
  never heard. The browser test caught that, and it's fixed.
- Both paths: a 45 s cap per answer, a **Done speaking** button, and nudges at 6 s and
  12 s of silence.

## 3. Handling misunderstanding and unclear communication

This is the part that makes or breaks a voice-first app for beginners. There are two
directions: **the user didn't understand us**, and **we didn't understand the user**.

### A. The user didn't understand the bot
Detected by `server/clarify.js` in two layers:

1. **Fast lexical match** (Hindi, Hinglish and English): *"what?", "sorry?", "repeat",
   "again", "pardon", "samajh nahi aaya", "kya?", "phir se bolo", "Hindi mein bolo",
   "slowly", "dheere"*, and their Devanagari forms.
2. **LLM fallback** for ambiguous short replies. Sarvam-105B classifies the reply as one of
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
SARVAM_STT_MODEL=saaras:v4            # REST fallback
SARVAM_STT_MODE=codemix
SARVAM_REALTIME=auto                  # auto (try, fall back to REST) | off
SARVAM_REALTIME_MODEL=saaras:v4       # or saaras:v3-realtime
SARVAM_REALTIME_STREAM_TYPE=balanced  # fast = lower-latency partials
SARVAM_TTS_MODEL=bulbul:v4-flash
SARVAM_TTS_SPEAKER=ishita_enhi_companion
SARVAM_LLM_MODEL=sarvam-105b
SARVAM_LLM_REPLY_MODEL=sarvam-105b-conversations
SARVAM_LLM_REASONING_EFFORT=low       # "none" is rejected by Sarvam models
SARVAM_TRANSLATE_MODEL=mayura:v1
```

LLM settings: `temperature: 0.2` + JSON mode for judging (consistent, parseable).
`temperature: 0.6` for the acknowledgment. On a parse failure the server retries once,
then falls back to feature-only scoring.

## 5. Failure and degradation
- **Realtime socket unavailable** → REST STT, automatically (see §2.1).
- **Sarvam unavailable or no key** → the app runs in **demo mode**: browser Web Speech
  API for STT and TTS, plus heuristic scoring only. The UX stays testable without a key.
- **Timeouts:** STT 10 s, TTS 8 s, LLM 15 s, with a single retry on 5xx or 429 and
  backoff.
- **Every turn is logged** (transcript, features, LLM scores, chosen route) so the
  thresholds can be calibrated against human-rated samples later.
