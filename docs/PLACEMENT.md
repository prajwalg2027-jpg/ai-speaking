# The placement test: two kinds

| | **Classic** (default) | **Conversation** (new, the alternative) |
|---|---|---|
| What it is | Five parts: about you, words, listening, reading aloud, speaking | Name, a picture, a line to read, then 1 to 3 open questions for those who can go on |
| Length | About 5 minutes, 8 or 9 turns | About 2 minutes |
| Feedback | Only at the end | A gentle fix inside Sakhi's reply after each answer, then two tips at the end |
| AI calls | Three per answer (understand, score, react) that don't see each other | One for every learner turn, from the hello to the goodbye |
| The level | Six skill scores, blended and averaged, cut-offs, four overrides (16 numbers) | The AI decides it at the end, from the whole talk, with a one-line reason |
| AI model | Sarvam-105B | Any of Sarvam, Claude, OpenAI, Gemini (a setting) |
| Code | `server/session.js`, `tutor.js`, `turn.js`, `scoring.js` | `server/placement/` |

Both stay. **Admin console › Settings › Placement test** chooses which one new tests use; a test in progress keeps
its kind. The app needs no change: both answer `/api/session` and `/api/session/turn` in the same shape.
Speech-to-text and Sakhi's voice are Sarvam in both.

Why the conversation exists: the classic test sounded like a quiz. Sakhi only wrote one short reaction between
scripted questions, could not praise or correct anything, switched format five times, and gave no feedback
until the end. Its scoring had become too complicated to predict.

## How a conversation goes

It goes from easy to hard, so nobody starts on a hard question:

1. **Hello**: "Hi, my name is Sakhi. What is your name?", in English and Hindi (the one fixed line).
2. **A picture** on the screen: she asks what it is called in English (dog, house, banana, fish, bread).
3. **A line to read** out loud from the screen: an everyday line if they named the picture, a very simple one if not.
4. **Open questions**, one to three, for those who can go on.
5. **Goodbye**: their level, one thing they did well, one thing to practise.

**Every learner turn goes to the AI** (`server/placement/brain.js`), one call per turn. It writes everything
Sakhi says and makes every judgement:

- **what happened**: they answered, asked for help, couldn't do it ("I can't see the picture"), said something
  else ("Pizza"), or gave up;
- whether the **picture was named** ("puppy" counts), and how the **line was read** (well, partly, not);
- whether they **can go on** to open questions: yes if they named the picture, read the line, or spoke real
  English sentences at any point;
- the **level of each open answer**, 1 to 4, and **one gentle fix** (she says the learner's idea back the right
  way: "I go market yesterday" → "Oh, you went to the market yesterday!", never "that's wrong");
- **when to finish**, and the **final level** with its reason and the feedback.

Code (`server/placement/conversation.js`) does only this:

- keeps the order of the steps and what is on the screen;
- limits how often a step repeats: help twice, a steer back from something off the point once; "couldn't do it"
  skips the step without counting against them;
- gives the AI a few facts in its note: whether the picture's word was in the reply, how many of the line's words
  matched, how many English words were spoken, how many questions are left;
- stops Sakhi giving away the picture's word before they answer, or reading the line out herself (such a line is
  dropped and a fixed one used);
- keeps a name only if the learner said it, and a fix only if it quotes their own words.

Levels: **1 Beginner** · **2 Basic** (knows words, simple sentences) · **3 Good** (connected sentences, the
past, reasons) · **4 Very good** (explains opinions and ideas at length, few mistakes). Every result is saved with
the AI's one-line reason and what it judged at each step ("Picture: named. Reading: well. Open answers: level 3,
level 4."), and says who decided it.

## When things go wrong

- **The AI is slow (9 s) or fails on a turn**: the talk carries on. For that turn the app uses its own checks
  (is the word there, how much of the line matched, how many English words) and the fixed lines.
- **The AI leaves the level out**, or failed at the end: the level comes from the app's own rule
  (`server/placement/level.js`: missed the picture and the reading is level 1; otherwise level 2 at least, and
  the highest level reached in two open answers). The result then says "decided by the app's rule".
- **The learner talks over Sakhi before her question** (open questions): they were still finishing; the two parts
  are joined and taken as one answer.
- **"Repeat"** (a button in the team view) says her last question again more slowly, without the AI.

## Choosing the AI model

Set in Settings › Placement test: the model for **each turn** does the whole talk, the level and feedback
included. (The second model there, "closing feedback", is only used if the first one leaves the level out.)
Any provider whose key is on the server can be chosen.

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

One request per learner turn, the same for every provider. The messages only ever grow, so each request repeats
the one before it and adds the new turn; providers reuse ("cache") the repeated part at a lower price:

```
system     Sakhi's fixed instructions (the same in every request of every talk)
user       (The call begins.)
assistant  Hi, my name is Sakhi. What is your name? …        ┐ the talk so far, as real turns,
user       My name is Ravi                                    │ exactly as it happened
assistant  Nice to meet you, Ravi! Look at the picture. …     ┘ ((said nothing), (skipped…) for silences)
…
user       I live in Pune with my family                      ← what the learner just said
system     NOTE FOR THIS TURN: the step, what the app measured, what to do next
```

The note is never kept in the talk, so it never disturbs the repeated part. OpenAI gets exactly this through its
**Responses API** (`POST /responses`, `input` + `text.format`, `store: false`). Claude, Gemini and Sarvam take
system instructions only at the start, so for them the note goes in as a last user message marked "[Note from
the app, not said by the learner]"; Claude is also told to cache the repeated part. The Compare models page
shows how many input tokens were cached on each turn. Caching only starts once a request is long enough (about
a thousand tokens for OpenAI); the fixed instructions alone are about two thousand tokens, so reuse can start
on the first turn. The goodbye, level and feedback come in the last turn's answer: no extra request.

## What to know about letting the AI decide

Results depend on the model: two models, or the same model twice, can give the same learner different levels.
There is no fixed rule behind a level any more, only the AI's stated reason. The Compare models page is the
place to see how much models differ before choosing one. No listening task and no harder word puzzles are in
this test (the result has no skill bars); the learning module keeps adjusting the level from real practice.

## Where things are

`server/placement/level.js` (the rule), `brain.js` (the prompts and the two AI jobs), `conversation.js` (the
talk), `index.js` (classic or conversation); `server/admin/placementLab.js` (Compare models);
`server/llm/` (providers); tests: `test/placement-conversation.test.js`, `test/placement-http.test.js`,
`test/llm-providers.test.js`.
