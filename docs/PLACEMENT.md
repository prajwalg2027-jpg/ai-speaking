# The placement test: two kinds

| | **Classic** (default) | **Conversation** (new, the alternative) |
|---|---|---|
| What it is | Five parts: about you, words, listening, reading aloud, speaking | Name, a picture, a line to read, then 1 to 3 open questions for those who can go on |
| Length | About 5 minutes, 8 or 9 turns | About 2 minutes |
| Feedback | Only at the end | A gentle fix inside Sakhi's reply after each answer, then two tips at the end |
| AI calls per answer | Three (understand, score, react) that don't see each other | None for the name, picture and reading; one for each open answer |
| The level | Six skill scores, blended and averaged, cut-offs, four overrides (16 numbers) | Missed picture and reading: 1. Otherwise 2 at least, and the highest level reached in two open answers |
| AI model | Sarvam-105B | Any of Sarvam, Claude, OpenAI, Gemini (a setting) |
| Code | `server/session.js`, `tutor.js`, `turn.js`, `scoring.js` | `server/placement/` |

Both stay. **Admin console › Settings › Placement test** chooses which one new tests use; a test in progress keeps
its kind. The app needs no change: both answer `/api/session` and `/api/session/turn` in the same shape.
Speech-to-text and Sakhi's voice are Sarvam in both.

Why the conversation exists: the classic test sounded like a quiz. Sakhi only wrote one short reaction between
scripted questions, could not praise or correct anything, switched format five times, and gave no feedback
until the end. Its scoring had become too complicated to predict.

## How a conversation goes

It goes from easy to hard, so nobody starts on a hard question (an open question first frightened beginners off):

1. **Hello**: "Hi, my name is Sakhi. What is your name?", in English and Hindi. Not counted.
2. **A picture** on the screen: "What is this called in English?" (dog, house, banana, fish, bread).
3. **A line to read** out loud from the screen: an everyday line if they named the picture, a very simple one if
   not. Sakhi never says the line.
4. **Open questions, only if they qualify**: they named the picture, or read at least 70% of the line. The first
   is an everyday one ("What did you do this morning?"), in English and Hindi.

Steps 1 to 3 use fixed lines and no AI, so Sakhi answers at once ("Yes, that's right!", or "In English, this is
called 'dog'."). From step 4, after each answer **one AI call** (`server/placement/brain.js`) returns, together:
whether it was an answer; the **level of the answer**, 1 to 4, with a one-line reason; **one gentle fix** (Sakhi
says the learner's idea back the right way: "I go market yesterday" → "Oh, you went to the market yesterday!",
never "that's wrong"); her reaction; and her **next question**, pitched at the level the code asked for.
**Code decides** what comes next and the final level (`server/placement/level.js`). At the end a second AI call
writes the feedback from the open answers: two things they did well, two to practise (starting from the fixes
she already made), and what she says to close. The level is said in fixed words.

Language: the fixed steps are in English and Hindi. In the open questions Sakhi matches the learner: simple
English with Hindi added when they struggle or answer in Hindi; natural English and no Hindi when they're
comfortable. She repeats, slows down or switches language when asked.

## The level rule (all of it)

Levels: **1 Beginner** · **2 Basic** (knows words, simple sentences) · **3 Good** (connected sentences, the
past, reasons) · **4 Very good** (explains opinions and ideas at length, few mistakes).

- **Missed the picture and the reading: level 1.** The talk ends there, kindly, after three easy steps.
- **Qualified: level 2 at least.** Higher comes from the open answers: **the highest level reached in two answers.**
- **How many open questions:** an answer at level 1 or 2 to the first one ends the talk (level 2). A stronger
  answer gets a second question, one level up. The same level twice ends it; otherwise a third, at the higher
  of the two. Never more than the setting "Most questions in a conversation" (3).
- **Checks on what was measured**, not on the AI's opinion: an answer that's mostly not English, or under 3
  English words, is level 1; an answer under 8 English words is level 2 at most; under 25 English words in all
  the open answers is level 2 at most.
- An open question they couldn't answer, after help twice or a skip, counts as one level below that question.

So a beginner does three or four short turns; a strong speaker does five or six. Every result carries its reason
("Named the picture; read 92% of the line. Open answers were at levels 3, 4, 4: level 4 was reached twice."),
saved with the test and shown on the result screen.

## When things go wrong

- **"Sorry?", silence, "in Hindi"**: Sakhi asks again more slowly with the Hindi (once on the fixed steps, twice
  on open questions), then moves on kindly. "Repeat" says the question again more slowly without the AI.
- **The AI is slow (9 s) or fails**: the talk carries on. Sakhi says "Okay.", the answer's level comes from the
  number of English words (never above 3), and the next question comes from the reviewed question bank.
- **The learner talks over Sakhi before her question**: they were still finishing; the two parts are joined and
  taken as one answer.
- **A fix the learner never said** (the AI imagined it) is dropped. Names are only used if the learner said them.

## Choosing the AI model

Two jobs, set separately in Settings › Placement test: **each turn** (speed matters) and **the closing
feedback** (once per test). Any provider whose key is on the server can do either.

1. Add keys (Cloud Shell; typed at a hidden prompt, stored in Secret Manager):

   ```bash
   PROJECT=cool-arch-515210-b0 PROVIDERS=anthropic,gemini ./deploy/llm-keys-setup.sh
   ```

2. **Admin console › Compare models**: pick up to four models. Each runs its own conversation, side by side, from
   the hello to the level and feedback; they all start with the same picture, line to read and first open
   question. What you type goes to every conversation; once the models ask different questions, each column has
   its own box too. For each model you see what Sakhi says, the level it gives, the fix, the speed, the tokens
   (input, cached, output, thinking) and the cost, and a total for the whole talk. A price can be typed for
   models the server has no price for. "Use this model for the placement test" saves it.
3. Settings › Placement test › **Conversation** switches new tests over. Classic switches back.

Notes on providers (`server/llm/`):
- **Claude** uses Anthropic's official SDK. Models: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`.
  It asks for the answer as structured output and for low effort (fast replies; `ANTHROPIC_EFFORT` changes it).
- **Gemini** uses Google's OpenAI-compatible endpoint; **OpenAI** its own. Type the model name.
- None of the three has been run against the real service from this repository (no keys here): the tests use
  stand-ins. Try each on the Compare models page before switching learners to it.
- Cost shown is an estimate (Sarvam and Claude prices are known to the code; others show "–"). Spending on
  providers other than Sarvam is not counted towards the daily budget limit yet.
- **Privacy**: with a provider other than Sarvam, the text of what learners say is sent to that company's
  servers, outside India. The privacy policy needs to say so before learners are switched to one. Voice
  recordings and speech-to-text stay with Sarvam.

## How a turn is sent to the AI

One request per open answer, the same for every provider. The messages only ever grow, so each request repeats
the one before it and adds the new turn; providers reuse ("cache") the repeated part at a lower price:

```
system     Sakhi's fixed instructions (the same in every request of every talk)
user       (The call begins.)
assistant  Hi, my name is Sakhi. What is your name? …        ┐ the talk so far, as real turns,
user       My name is Ravi                                    │ exactly as it happened
assistant  Nice to meet you, Ravi! Look at the picture. …     ┘ ((said nothing), (skipped…) for silences)
…
user       I live in Pune with my family                      ← what the learner just said
system     NOTE FOR THIS TURN: the question's level, what was measured, what to do next
```

The note is never kept in the talk, so it never disturbs the repeated part. OpenAI gets exactly this through its
**Responses API** (`POST /responses`, `input` + `text.format`, `store: false`). Claude, Gemini and Sarvam take
system instructions only at the start, so for them the note goes in as a last user message marked "[Note from
the app, not said by the learner]"; Claude is also told to cache the repeated part. The Compare models page
shows how many input tokens were cached on each turn. Caching only starts once a request is long enough (about
a thousand tokens for OpenAI), so the first open answer of a talk may show none.

The closing feedback is one more, small request of its own.

## What the conversation does not measure

No listening task and no harder word puzzles, and reading only decides who goes on to the open questions (the
result has no skill bars). The learning module keeps adjusting the level from real practice.

## Where things are

`server/placement/level.js` (the rule), `brain.js` (the prompts and the two AI jobs), `conversation.js` (the
talk), `index.js` (classic or conversation); `server/admin/placementLab.js` (Compare models);
`server/llm/` (providers); tests: `test/placement-conversation.test.js`, `test/placement-http.test.js`,
`test/llm-providers.test.js`.
