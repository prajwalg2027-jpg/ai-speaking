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
The reply's `trace` shows each step (understand, profile, plan, tutor, judge) in the log panel.
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

## Understanding the learner (memory and coherence)
A real session went wrong in five ways: Sakhi invented a name ("Riya") and kept using it, "I would like to speak
in Hindi" was scored as the introduction, a complaint ("my name is not Riya") was scored as the weekend answer,
reactions brought back old topics, and the half of a word task the learner skipped was never asked again.
The fixes:

- **Understand step** (`understandTurn` in `server/turn.js`): every reply that isn't an obvious short request is
  read by Sarvam-105B (about 0.4–0.6 s): `answer`, `meta` (a correction, complaint or question to Sakhi),
  `in_hindi`, `repeat`, `slower`, `dont_know`, `skip`, plus the learner's name (only if they said it), new facts
  about them, and whether they want Hindi. Off-topic attempts still count as answers.
  Scoring and Sakhi's next line start at the same time, assuming the reply is an answer; if it isn't, both are
  dropped and Sakhi responds to what was actually said. Turns that are answers take no longer than before.
- **Learner profile** (`s.profile`): `{name, facts, prefersHindi}`, given to the tutor as ABOUT THE LEARNER.
  The tutor sees the last 12 lines of the conversation.
- **Name guard** (`stripInventedNames` in `server/tutor.js`): any name Sakhi uses to address the learner that
  isn't the name they gave is removed before she speaks ("Thank you, Riya." → "Thank you."). A name the learner
  says is "not" theirs is never stored.
- **Replies that aren't answers**: not scored. Sakhi responds (apologises if corrected), then asks the same
  thing again in fresh words. After the third such reply in a row she moves on.
- **Talking in the learner's language**: "can you speak in Punjabi?" switches Sakhi to Punjabi for the rest of the
  conversation (Hindi, Marathi, Punjabi, Bengali, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam; see
  `shared/languages.js`). Hindi uses the scripted lines; the others are written by the tutor, and a line not in the
  chosen script is retried once. Task words stay in English, the voice language follows the script, and "speak in
  English" switches back. A language Sakhi can't speak gets a kind no, with Hindi or English offered. Tasks start
  at level 2 at most for a learner who asked for another language, and count as "needed help in their language".
- **One question at a time**: the opening asks only what they do during the day; each word task asks its two words
  as two separate questions, each with its own card, and scores both replies together ("I don't know" to the first
  still gets the second; naming both at once skips it). Every tutor line is cut after its first question mark;
  read-aloud lines have none.
- **Reactions**: only about the learner's last line; after a word task, a brief neutral "Okay!". The summary has no
  reaction and no questions.

## Interruptions (barge-in)
Nothing the learner says when they talk over Sakhi is lost, and the server knows what they heard.

- **Capture from the first syllable** (`public/live.js`, `public/audio.js`): the mic is kept in a 10 s buffer
  while nothing is streamed, each piece stamped with its time. The start of each stretch of speech is tracked
  all the time. When listening starts, audio is sent from 300 ms before that start (at most 3 s back), however
  long listening took to start (a reconnect included). Speech that ran over the end of Sakhi's line without
  interrupting her is kept the same way. Before, a fixed length counted back from "now" was sent.
- **Duck, then stop**: the instant the learner's voice is clearly above the noise, Sakhi drops to a quarter of
  her volume (so echo cancellation swallows less of their first words). After 300 ms of voice she stops; if it
  was a cough, her volume comes back after 600 ms. Her whole turn stops, not just the current line.
- **What was heard**: the app reports which line was cut and after how many seconds. The server cuts that line
  in the conversation memory to the words heard, marked "[the learner talked over Sakhi here]", and works out
  whether the question was heard.
- **Still finishing the last answer?** An LLM check (about 0.4 s, interrupted turns only) decides whether the
  learner was adding to their previous answer. If so, the server goes back to before that answer and scores
  the two together as one (this also works over the closing summary, which is then given again).
- **Replying to the reaction, not the question**: if they talked over Sakhi before her question and only
  answered what they'd heard ("yes, it's fun"), it isn't scored: Sakhi responds and asks the question. A reply
  that answers it anyway (or is 12+ words) is scored as usual.

Replaying the reported session's words through the fixed version: no name is ever used, the Hindi request is
honoured, "This is called umbrella." gets "अब 'library' के लिए Hindi का शब्द क्या होता है?", the complaint gets
an apology and the weekend question again, and the popcorn answer is scored as the weekend answer.

## Guardrails on every tutor line
- **Task intact:** the line must contain the task's key words (e.g. "zimmedari" and "deadline"), or the
  scripted line is used instead.
- **Never the answer:** lines containing an answer ("responsibility", "apple", "सेब", "umbrella"…) are rejected.
  Read-aloud lines may not contain any four consecutive words of the sentence.
- **No verdicts:** any sentence that judges the learner ("perfect", "correct", "you know so many words",
  "your English is…", "बिल्कुल सही", "शाबाश") is removed, in the reaction and in the task line. Apologies
  ("sorry, my mistake", "मुझसे ग़लती हो गई") are kept. Only the closing summary may say how they did.
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

## Assessment: English only, measured not guessed
- **English only**: word tasks are pictures or English clues (no translating Hindi words, no "Hindi word for
  library"). An answer in another language (Hindi in any script, including Latin letters, as judged by the
  understand step) isn't scored the first time: Sakhi asks "Can you try saying that in English?". A second one
  is scored, with English words, sentences, smoothness and ideas capped at 0.5.
- **Listening**: Sakhi leads in, then says two fixed sentences (never on screen) and asks one question about them.
  Repeat says them again more slowly; the second help gives the question in Hindi.
- **Picture description** for levels 1–2 (opinion questions for 3–4), each with a follow-up.
- **Fluency from the mic**: Sarvam gives no word timestamps, so the app measures voicing and pauses itself while
  listening (`stopTiming()` in `public/audio.js`): speaking rate, pauses ≥ 0.25 s, long pauses ≥ 1 s, and words
  between pauses. These drive the fluency score and are given to the judge.
- **Pronunciation** is only scored from read-aloud (word accuracy against the sentence). Elsewhere it is left out
  of the averages instead of a made-up 2/4.
- **Result in simple words**: levels are Beginner, Basic, Good, Very good ("level 2 of 4, Basic"). The screen shows
  "What you did well" and "What we'll practise next" (written from their own answers; tips that quote words they
  never said are dropped) and skills named in everyday words.

## Haptics
On Android the phone vibrates when it's the learner's turn to speak (45 ms) and gives a lighter tap (18 ms) when
their answer is complete and being processed. No "your turn" buzz after an interruption (they're already talking).
iPhones don't support web vibration. `?haptics=0` in the URL turns it off.

## Question bank (reviewed)
The questions live in `shared/bank.js`: 91 approved in review (review page `/review.html`, batches in
`public/review/`). Each type has a pool per level, and each conversation picks one question at random from each
pool, so retakes rarely repeat: 3 openings; word pairs 5/2/5/6 (levels 1-4); listening 6 per level; read-aloud
6/6/6/5; speaking 5/6/6/6. Help lines (simpler English, Hindi) were drafted with Sarvam-105B and checked by hand.
`docs/question-bank.xlsx` lists every item. Result tips ("what to practise") come only from open answers.

## The app screen (mobile-first)

The default view is the customer view, built from the design handoff: the Molten orb (tap to start, tap to
interrupt Sakhi, tap to say you're done), Sakhi's lines revealed word by word in step with her voice, a live
"Listening" bubble for your words, the fanned hint card (emoji / word / sentence) for word tasks, and the result
card with the level ring, a Hindi line and simple tips. Light and dark follow the phone's setting (`?theme=dark`
forces dark; `?rm=1` forces reduced motion).

The team view adds the developer log, the Sarvam cost counter and the help chips (Done speaking, Repeat, Hindi
mein, Skip). Open it with `/?internal=1`; the choice is remembered on that browser until `/?internal=0`.

Code: `public/index.html`, `styles.css` (tokens and layout), `orb.js` (the orb animation loop), `ui.js` (screen
parts), `app.js` (the conversation flow). The server sends `cue` (show, deal or remove the card) and the card's
look with each turn.
