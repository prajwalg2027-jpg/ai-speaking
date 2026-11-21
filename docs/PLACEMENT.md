# The placement test: two kinds

| | **Classic** (default) | **Conversation** (new, the alternative) |
|---|---|---|
| What it is | Five parts: about you, words, listening, reading aloud, speaking | A short talk: 2 to 4 questions about the learner's life |
| Length | About 5 minutes, 8 or 9 turns | About 2 minutes |
| Feedback | Only at the end | A gentle fix inside Sakhi's reply after each answer, then two tips at the end |
| AI calls per answer | Three (understand, score, react) that don't see each other | One, that does all of it |
| The level | Six skill scores, blended and averaged, cut-offs, four overrides (16 numbers) | The highest level reached in two answers, plus four measured checks |
| AI model | Sarvam-105B | Any of Sarvam, Claude, OpenAI, Gemini (a setting) |
| Code | `server/session.js`, `tutor.js`, `turn.js`, `scoring.js` | `server/placement/` |

Both stay. **Admin console › Settings › Placement test** chooses which one new tests use; a test in progress keeps
its kind. The app needs no change: both answer `/api/session` and `/api/session/turn` in the same shape.
Speech-to-text and Sakhi's voice are Sarvam in both.

Why the conversation exists: the classic test sounded like a quiz. Sakhi only wrote one short reaction between
scripted questions, could not praise or correct anything, switched format five times, and gave no feedback
until the end. Its scoring had become too complicated to predict.

## How a conversation goes

1. **Opening**, the same for everyone, in English and then Hindi, and a first question in both
   ("What did you do this morning?").
2. After each answer, **one AI call** (`server/placement/brain.js`) returns, together:
   - whether it was an answer (or a request for help, silence, something else),
   - the **level of the answer**, 1 to 4, with a one-line reason,
   - **one gentle fix**: Sakhi says the learner's idea back the right way
     ("I go market yesterday" → "Oh, you went to the market yesterday!"), never "that's wrong",
   - Sakhi's reaction and her **next question**, pitched at the level the code asked for.
3. **Code decides** what comes next and the final level (`server/placement/level.js`).
4. At the end a second AI call writes the feedback: two things they did well, two to practise (starting from the
   fixes she already made), and what she says to close. The level is said in fixed words.

Language: Sakhi matches the learner. Simple English with Hindi added when they struggle or answer in Hindi;
natural English and no Hindi when they're comfortable. She repeats, slows down or switches language when asked.

## The level rule (all of it)

Levels: **1 Beginner** (words and phrases, or mostly not English) · **2 Basic** (simple sentences about
everyday life, many mistakes) · **3 Good** (connected sentences, the past, reasons) · **4 Very good** (explains
opinions and ideas at length, few mistakes).

- **The result is the highest level reached in two answers.**
- **Which question comes next:** question 1 is a warm-up. Question 2 is one level above the first answer.
  After two answers at the same level, it ends. Otherwise a third question, at the higher of the two. After
  three it ends, unless the third answer was above the level so far: then one last question. Never more than
  the setting "Most questions in a conversation" (4).
- **Four checks on what was measured**, not on the AI's opinion:
  an answer that's mostly not English, or under 3 English words, is level 1; an answer under 8 English words is
  level 2 at most; under 5 English words in the whole talk is level 1; under 25 is level 2 at most.
- A question they couldn't answer, after help twice or a skip, counts as one level below that question.

Every result carries its reason in one or two sentences ("Answers were at levels 3, 4, 4: level 4 was reached
twice."), saved with the test and shown on the result screen.

## When things go wrong

- **"Sorry?", silence, "in Hindi"**: Sakhi helps and asks the same question more simply (twice at most), then
  moves on kindly. "Repeat" says the question again more slowly without the AI.
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

2. **Admin console › Compare models**: pick the model that runs the conversation and up to three others. Type
   what a learner would say. Each model is given exactly the same turn; you see what Sakhi would say, the level
   it gives, the fix, the speed and the cost, side by side, and each model's closing feedback at the end.
   "Use this model for the placement test" saves it.
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

## What the conversation does not measure

No picture words, listening task or reading aloud, so no separate pronunciation or listening score at
placement (the result has no skill bars). Those belong in the first lessons; the learning module keeps adjusting
the level from real practice.

## Where things are

`server/placement/level.js` (the rule), `brain.js` (the prompts and the two AI jobs), `conversation.js` (the
talk), `index.js` (classic or conversation); `server/admin/placementLab.js` (Compare models);
`server/llm/` (providers); tests: `test/placement-conversation.test.js`, `test/placement-http.test.js`,
`test/llm-providers.test.js`.
