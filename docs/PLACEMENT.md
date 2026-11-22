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

What Sakhi says on a turn comes in two parts, `reply` (her reaction to what they said) and `question` (what she
asks next). They are spoken one straight after the other, as a single turn, and the fixed instructions tell the
model so plainly: `question` picks up from where `reply` ended (it does not start afresh, react again or repeat
it), and `reply` holds no question at all.

Code (`server/placement/conversation.js`) does only this:

- keeps the order of the steps and what is on the screen;
- limits how often a step repeats: help twice, a steer back from something off the point once; "couldn't do it"
  skips the step without counting against them;
- gives the AI a few facts in its note: whether the picture's word was in the reply, how many of the line's words
  matched, how many English words were spoken, how many questions are left;
- stops Sakhi giving away the picture's word before they answer, or reading the line out herself (such a line is
  dropped and a fixed one used);
- keeps a name only if the learner said it, and a fix only if it quotes their own words;
- leaves out any question the model put in `reply` anyway, so she asks one thing, once (in `question`).

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
- **The learner talks over Sakhi**: nothing already in the talk is changed. Her whole line stays as she said it,
  and the app adds a line after it saying how much of it they heard (see "When the learner talks over Sakhi").
  If they cut in before her question (open questions), they were still finishing their answer: their new words
  are a new turn, and the AI is told to judge the parts together as one answer to the earlier question.
- **"Repeat"** (a button in the team view) says her last question again more slowly, without the AI.

## When the learner talks over Sakhi

The app tells the server how far into her turn she was when they started talking. The talk is never rewritten:

```
assistant  You made tea in the morning!                       ← her whole turn, as she said it
           Who do you live with?
user       [The app: Sakhi was cut off here] The learner started talking while she was still speaking.
           They heard only: "You". They did not hear: "made tea in the morning! Who do you live with?"
user       and then I walked to the market                    ← only their new words
system     NOTE FOR THIS TURN … THEY WERE STILL ANSWERING. … Everything they have said since you asked
           "So, what did you do this morning?" is ONE answer … Judge the parts together …
```

- **They heard her question** (or most of it): their words are a reply to it. The note says what they heard.
- **They cut in before her question**, right after an open answer: they were still answering. The note names the
  earlier question and tells the AI to judge all the parts as one answer; the app's word count covers all the
  parts. The app's own record of that answer (its level) is replaced by the new judgement, so it still counts as
  one answer to one question. The talk itself is not touched. A third part joins the same way.
- The fixed instructions tell the AI how to read the cut-off line: words they did not hear were never said, as
  far as the learner knows.

**The trade-off.** Before, the talk held only the words the learner heard, so the AI could not lean on anything
else. Now the unheard words are in front of it, marked as unheard, and it has to follow that mark. A model may
still behave as if they were heard: refer back to them ("as I asked"), skip a fix it thinks it already gave, or
ask a different question from the one it had planned without noticing. The cut-off line, the rule in the fixed
instructions and the note for the turn all point the same way to keep this rare, and stronger models follow it
more reliably than small ones; it is worth watching in real calls. What is gained: the talk is a true record of
what she said, each request is the last one plus new messages (the reusable part is never disturbed), and the
code no longer edits the past. The saving in reused tokens is small in itself, because the old edits only
touched the two newest turns. A request with a cut-off is a little longer (her full line and the app's line).

## How hard the model thinks

Two settings (Settings › Placement test), for models that take a thinking level (OpenAI's, Claude's; Sarvam and
Gemini ignore them):

- **Thinking on each turn**: `low`. The learner is waiting to hear Sakhi, so speed matters most.
- **Thinking for the final level and feedback**: `medium`. Care matters most.

Each can be `default` (the model's own: medium for `gpt-6-luna`), `none`, `low`, `medium` or `high`. OpenAI
gets it as `reasoning.effort`; Claude as its effort (it has no "none": low is used). A model that refuses a
thinking level is asked again without one, and that is remembered.

The level and feedback come in the answer to the last turn, so "the final evaluation" is that turn:
- When the app knows the turn is the last (the last open question allowed), that one call is made at the final
  level.
- When the AI itself ends the talk earlier, on a turn it thought about lightly, the same turn is asked **once
  more** at the final level, told to finish, and that answer is used (if it fails, the first one stands). This
  costs one more call and its wait, only at the end of such a talk. The request is the same up to the note, so
  nearly all of it is reused from cache. Set both settings the same to never make the second call.

The Compare models page shows the thinking level on every call and lists the second call in the log.

## Streaming: Sakhi starts sooner

**Her voice has always been streamed**: the app asks for one line at a time and plays the sound as Sarvam makes
it (`/api/tts/stream`), so she starts speaking before the line is fully generated. What was not streamed was the
AI's answer: the server waited for the whole of it before anything could be spoken.

With an **OpenAI** model (the Responses API, `stream: true`) the answer is now read as it is written. Its fields
come in a fixed order, and her reply is written before her question and before the final level and feedback.
So, as soon as the reply is complete:

1. the server works out the lines she will say for it (the same rules as the turn itself: names, the picture's
   word, the line to read), and
2. starts making their voice, while the model is still writing the rest.

By the time the app has the turn and asks for her first line, the sound is ready or well on its way; the app
joins it from its first byte (a line being made is shared, never made twice). Nothing changes in the app.

What this buys, per turn: roughly the time the model spends on everything after the reply (short on an ordinary
turn; a second or more on the last turn, where the level and feedback are written), up to the time her voice
takes to start. The model's thinking before it writes anything is not shortened by streaming: that is what the
thinking level above is for.

Limits, so nobody is surprised:
- The app still waits for the whole turn before it plays anything. Playing her reply while the rest is still
  being written needs the turn itself to reach the app in pieces: a change to the app and to
  `/api/session/turn`, not made yet.
- Only OpenAI models are streamed. Sarvam, Claude and Gemini answer in one piece, as before.
- If her reply is dropped afterwards (a guard, or an answer that had to be asked for again), the voice started
  early is not used: a few characters of voice spent for nothing. Rare.
- The Compare models page shows, for each call, when the first words of the answer arrived and when her reply
  was ready, and the average in the side-by-side table. It does not play sound.

## Choosing the AI model

Set in Settings › Placement test: the model for **each turn** does the whole talk, the level and feedback
included. (The second model there, "closing feedback", is only used if the first one leaves the level out.)
Any provider whose key is on the server can be chosen.

1. Add keys (Cloud Shell; typed at a hidden prompt, stored in Secret Manager):

   ```bash
   PROJECT=cool-arch-515210-b0 PROVIDERS=anthropic,gemini ./deploy/llm-keys-setup.sh
   ```

2. **Admin console › Compare models**: pick up to four models (it starts with the model in use beside OpenAI's
   `gpt-6-luna`). Each runs its own conversation, side by side, from the hello to the level and feedback; they
   all start with the same picture, line to read and first open question.
   - **Type or speak.** What you type goes to every conversation; once the models ask different questions, each
     column has its own box too. **Speak** records from your microphone (up to 30 seconds) and Sarvam turns it
     into words exactly as in the app (`POST /api/admin/placement-lab/transcribe`); only the words are sent on.
     Sakhi's replies are shown as text, not spoken.
     On adamspeaks.in the website switches the microphone off for every page except `/admin` (the
     `Permissions-Policy` header in `website/firebase.json` on the website branch), so the website must be
     deployed once after that change before Speak works there.
   - **Per turn** you see what Sakhi says, what the model judged (what happened, the picture, the reading, the
     level, the fix), the speed, the tokens (input, reused from cache, output, thinking) and the cost.
   - **View log** (per model) lists every AI call in order: the request exactly as that provider received it,
     message by message; the thinking, where the provider shares a summary of it (OpenAI and Claude do; the full
     thinking is never shared); the answer exactly as it came; and what Sakhi then said. A bar shows how much of
     the input was reused from cache, and each message is marked reused, partly reused or new. Providers report
     only how many input tokens were reused, not which: reuse always starts at the top of the request, so the
     marks are worked out from each message's length and are an estimate. "Copy log" copies it all as text.
   - **Side by side**, under the conversations: level, who decided it, AI calls, total and average time, input
     tokens, the share reused, output and thinking tokens, and cost, for each model.
   - **Speech-to-text and voice cost.** Under each turn, and in the totals, the page shows what the same talk
     would cost in the app besides the AI, at Sarvam's prices (`server/costs.js`: ₹30 for an hour of speech,
     ₹20 for 10,000 characters of voice, both settable): speech-to-text for the learner's words (the recording's
     real length when spoken into the page; estimated at two words a second when typed) and Sakhi's voice for
     what she said (her fixed lines are made once ahead of time and cost a talk nothing). The side-by-side table
     adds them to the AI cost for a cost in all. These are estimates: the page plays no sound, and in the app
     the microphone also sends the pauses around the learner's words, so real speech-to-text runs somewhat higher.
   - **Prices.** Each model's price is shown as you pick it. OpenAI's are its standard list prices for every
     model, read once from its pricing page (the date is shown; `server/llm/prices.js`); they do not update on
     their own. Costs are shown in rupees at `USD_INR` (88 unless set). A different price can be typed.
   - "Use this model for the placement test" saves it. Nothing else on the page is saved.
3. Settings › Placement test › **Conversation** switches new tests over. Classic switches back.

Notes on providers (`server/llm/`):
- **Claude** uses Anthropic's official SDK. Models: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`.
  It asks for the answer as structured output and for low effort (fast replies; `ANTHROPIC_EFFORT` changes it).
- **Gemini** uses Google's OpenAI-compatible endpoint; **OpenAI** its own. Type the model name.
- None of the three has been run against the real service from this repository (no keys here): the tests use
  stand-ins. Try each on the Compare models page before switching learners to it.
- Cost shown is an estimate (Sarvam, Claude and OpenAI prices are known to the code; others show "–"). Spending on
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

Stable things come first (the fixed instructions, then the talk in order) and new messages are only ever added
at the end: nothing already sent is edited or removed, so everything before the newest turn is identical from one
request to the next and can be reused.

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
