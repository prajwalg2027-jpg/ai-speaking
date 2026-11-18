# Conversational placement: how Sakhi talks

The placement used to sound like a quiz: the same scripted questions for everyone, generic reactions
("Nice!"), no link between questions, a "2 / 4" counter, and 2–4 s of silence while each reply was prepared.
It now runs as a conversation with a tutor, and the assessment happens inside it.

## Who decides what

| Part | Where | What it does |
|---|---|---|
| Conversation | `server/session.js` | Remembers what the learner said, picks the next step (follow-up, next task, bonus sentence, help, finish), keeps the score. Sessions live in memory for two hours; nothing is stored. |
| Tutor | `server/tutor.js` | Sarvam-105B (conversations) writes Sakhi's line: a reaction to what the learner said, a bridge, and the task in natural words. |
| Assessment tasks | `shared/assessment.js` | Fixed. Each task variant has guardrails: words Sakhi must use and words she must never say. |
| Scoring | `server/turn.js`, `server/scoring.js` | Unchanged rubric; runs at the same time as the tutor. Follow-up answers count as extra evidence. |
| Browser | `public/app.js` | Audio and screen only: plays Sakhi's turn, listens, plays a quick reaction, sends the turn. |

API: `POST /api/session` (opening turn) and `POST /api/session/turn` with
`{sessionId, event: answer | no_speech | live_failed | skip | repeat | in_hindi, transcript, languageCode, speechSec}`.
Each reply is `{say: [{text, lang, pace}], card, listen: {silenceMs, language}, done?}`.

## The flow
1. **Opening** (scripted, the same for everyone): "Tell me a little about yourself…"
2. **Follow-up** about something specific they said ("What kind of work do you do?").
3. **Vocabulary**, connected to their life ("If you had to explain 'zimmedari' to one of your students…").
4. **Read-aloud** (a brief thanks after it, never a reaction to the sentence; a harder bonus sentence after a
   near-perfect reading).
5. **Opinion**, then a **follow-up**.
6. **Spoken summary**: the level name, one strength, one thing to work on together.

Help keeps the same ladder: "repeat" → slower; second request or silence → simpler English, then Hindi;
third → move on kindly. A missed follow-up or bonus sentence never counts against the learner.

## Guardrails on every tutor line
- **Task intact:** the line must contain the task's key words (e.g. "zimmedari" and "deadline"), or the
  scripted line is used instead.
- **Never the answer:** lines containing an answer ("responsibility", "apple", "सेब", "umbrella"…) are rejected.
  Read-aloud lines may not contain any four consecutive words of the sentence.
- **No verdicts:** any sentence that judges the learner ("perfect", "correct", "you know so many words",
  "your English is…") is removed, in the reaction and in the task line. Only the closing summary may say how
  they did.
- **No corrections**, no questions in the reaction, length limits, follow-ups must be questions.
- **Level-appropriate language:** beginners get very simple English plus one polite Hindi sentence restating the
  task (बताइए, never बताओ); fluent learners get natural English and no Hindi.
- **4-second limit:** if the model is slow or fails, the scripted line is used.
- Read-aloud turns are marked in the history as "not the learner's own words" (otherwise the model once called
  the learner by the name in the sentence).

## No dead air
- **Quick reaction:** the moment the learner finishes (3+ words), a cached "Mm-hmm." / "Okay!" / "Achha." / "I see."
  plays while the server works.
- **Scoring and tutor in parallel:** the next step is chosen from instant measurements, so the tutor writes the
  reply while the LLM scores the answer.
- **Streamed voice:** `/api/tts/stream` relays Bulbul's `/text-to-speech/stream` (raw PCM); the browser plays
  each piece as it arrives. First audio in about 0.45–0.75 s, versus about 2.2 s for the whole clip before.
- **Pre-generated lines:** all 63 scripted lines are generated when the server starts and play instantly.

Measured in a browser run (stand-in for live speech-to-text, real Sarvam for everything else): the quick
reaction plays immediately; Sakhi's reply starts 1.7–2.2 s after the answer is complete (tutor 0.5–1.4 s,
first audio 0.45–0.75 s). Before, there were 1.7–4.6 s of silence with no reaction.

## Next
- Stream the tutor's text and start speaking the first sentence while the rest is written.
- Turn-taking: the answer is only "complete" after Sarvam's silence window (1.2–1.8 s) plus 700 ms grace;
  that's now the biggest part of the wait.
