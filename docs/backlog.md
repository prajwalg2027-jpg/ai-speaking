# Backlog and parked decisions

Items we've chosen to come back to. Grouped by the six parts of the improvement plan:
test set · Hearing · Turn-taking · Speaking · Understanding and replies · Assessment.

## Parked decisions (need a product call)
- **Ask for the learner's most comfortable language at the start** (Hindi, Tamil, Bengali…).
  Set it as Sarvam's `language_code` with `codemix` (Sarvam's documented recipe for Hinglish), and
  use it for Sakhi's help prompts instead of always Hindi. Today help prompts are Hindi only.
- **How the Android app is built**: native (Kotlin, `AudioRecord`/Oboe), cross-platform
  (React Native / Flutter), or the web app wrapped as an Android app (Trusted Web Activity / WebView).
  The server (relay, scoring, Sarvam calls) carries over unchanged; the mic and playback code depends
  on this choice. On native Android, the mic mode decides audio processing: `VOICE_COMMUNICATION`
  applies echo cancellation and noise suppression; `VOICE_RECOGNITION` is meant for speech
  recognition with little or no processing. The mic test results should inform this.
- **Hide the live log panel by default** before real learners use the app (keep it for testing).

## Hearing
- ~~Language detection is sticky in live mode~~ **Fixed:** the app re-arms detection at every question and
  after every final transcript (`config.update {language_code}`); read-aloud is fixed to `en-IN`. The STT
  lab's "Re-detect language after each utterance" switch shows the before and after on real Sarvam.
- **Context for speech-to-text** (next): live `prompt` (a context hint for final transcripts) and `keyterms`
  (names and places the learner mentioned), never the expected answer.
- **Mic processing on vs off**: run `/mic-test.html` on Android phones in 2–3 environments; decide
  the default (`?ns=0&agc=0` in the app URL already switches noise suppression and auto volume off).
- **Replace the deprecated ScriptProcessor** mic capture: AudioWorklet (web) or AudioRecord (native),
  after the Android decision above.
- **Compare `saaras:v4` with `saaras:v3-realtime`** (the live endpoint's default) for speed and accuracy.
- **Hesitation from audio, not text**: Sarvam drops most "um"/"uh". Measure pauses inside answers
  (count, longest, share of time paused) from the mic signal instead of counting filler words.
- If a REST fallback ever returns: uploads are limited to 30 s; split long answers at pauses.

- **Send at once vs live (cost)**: compare on real recordings in `/stt-lab.html`. Sending trimmed audio in one
  upload bills fewer seconds but the learner waits for upload and transcription after they stop, there are
  no live captions, and the phone must detect the end of the turn itself. A middle option: stream live but
  skip long silences on the phone (lab preset "Live · trimmed audio"), ending turns with `endpointing=manual`.
- Not in the STT lab yet: Sarvam's Batch API (async jobs, for audio over 30 s) and the legacy
  `/speech-to-text/ws` streaming endpoint; the `linear32` encoding (its exact format isn't documented).

## Turn-taking
- Barge-in thresholds (4× noise floor, 300 ms) were tuned on test clips only; check on real phones
  with the speaker on, where echo cancellation varies by device.

## Speaking
- ~~Pre-generate scripted prompts~~ **Done**, along with streamed voice (first audio in about 0.5 s).
- **Stream the tutor's text into the voice**: start speaking the reaction while the rest is written.
- The voice cache lives in memory; it's rebuilt (about 30 s) on every restart.

## Understanding and replies
- The keyword list misses common Hindi ways of saying "repeat" (e.g. "एक बार और बोलिए",
  "मुझे ठीक से सुनाई नहीं दिया"). Replies longer than 4 words skip the LLM check, so the second one
  is scored as an answer. Sarvam-105B classifies both correctly.

## Assessment
- **Read-aloud flatters learners**: recognition "fills in" familiar sentences. Rewrite read-aloud items
  around hard-to-guess sounds (v/w, th, minimal pairs), lower Q3's weight until validated, and add
  deliberately mispronounced recordings to the test set. Consider a pronunciation-assessment service
  only if it doesn't penalise an Indian accent.
- **Q3 counts in all six skills**, including grammar and vocabulary of a sentence the learner didn't
  write. Count only pronunciation and fluency from read-aloud.
- **Pronunciation is a constant 2 for Q1, Q2 and Q4**, which dilutes the read-aloud signal.

## Test set (foundation)
- 20–40 recordings of real learners across the four levels, each with an exact transcript (mistakes
  and fillers included) and a level from an English teacher. Include mispronounced readings.

---

## How to open the app or the mic test on an Android phone
The phone and the Mac must be on the same Wi-Fi. Chrome only allows the microphone on secure
pages, so do one of these once:

**Option A: Chrome flag (no cable)**
1. On the Mac, find its address: `ipconfig getifaddr en0` (e.g. `192.168.1.20`).
2. On the phone, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enter
   `http://192.168.1.20:3000`, set it to **Enabled**, and tap **Relaunch**.
3. Open `http://192.168.1.20:3000/mic-test.html` (or `/` for the app). Allow the microphone.
   If the Mac asks whether to accept incoming connections for `node`, choose Allow.

**Option B: USB cable**
1. Enable USB debugging on the phone and connect it.
2. On the Mac: `adb reverse tcp:3000 tcp:3000`.
3. On the phone open `http://localhost:3000/mic-test.html`.
