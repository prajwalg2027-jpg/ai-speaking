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

She is told to sound spoken, not written: now and then a small filler or thinking sound where a person would
pause ("Oh,", "Hmm,", "Um,", "So,"; "अच्छा," in Hindi), one or two in a turn at most and not on every turn,
only easy ones with a weak learner, and never in the written feedback or the line to read. The voice says them
as written.

What Sakhi says on a turn comes in two parts, `reply` (her reaction to what they said) and `question` (what she
asks next). They are spoken one straight after the other, as a single turn, and the fixed instructions tell the
model so plainly: `question` picks up from where `reply` ended (it does not start afresh, react again or repeat
it), and `reply` holds no question at all.

Code (`server/placement/conversation.js`) does only this:

- keeps the order of the steps and what is on the screen;
- limits how often a step repeats: help twice, a steer back from something off the point once; "couldn't do it"
  skips the step without counting against them;
- gives the AI a few facts, each said once in a short line of its own in the talk: whether the picture's word was in the reply, how many of the line's words
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

## When the learner leaves midway

Both tests (classic and conversation) can be carried on after a break: the app closed or killed, a phone call, the
phone locked, a lost connection, or a server release. Code: `server/placement/resume.js`.

- **Saved after every turn.** The test as the server holds it goes to `assessments.state` (migration 011), so it
  survives the app closing and server releases. It is cleared when the test ends, is abandoned, or the learner's
  data is erased.
- **Carrying on.** The app pauses the test when it leaves the screen (it can't listen unseen). On the next tap, it
  asks `POST /api/session/resume`; Sakhi says "Sorry, we got cut off. Let me ask again." (away under 3 minutes) or
  "Welcome back, Ravi! Let's carry on from where we stopped." and asks the question they were on again. Half an
  answer from before the break is not kept. In the conversation test, a line in the talk tells the AI about the break.
- **The window.** Settings › Limits › "Hours a learner can carry on a test" (`resumeHours`, 24; 0 turns it off).
  Only a test with at least one answer is carried on. After the window, or when the learner taps **Start over**
  (a new `POST /api/session`), the old test is marked `abandoned`.
- **Weak connections.** Each turn carries its number (`seq`). The app sends a turn again after 1, 2 and 4 seconds
  ("Reconnecting…"); the server answers a turn it has already handled with the same reply, so an answer is never
  counted twice.
- **Numbers.** Admin › Overview shows where placement tests are left (after how many answers) and how many were
  carried on after a break.

## When the learner talks over Sakhi

The app tells the server how far into her turn she was when they started talking. The talk is never rewritten:

```
assistant  You made tea in the morning!                       ← her whole turn, as she said it
           Who do you live with?
system     [System] RECORDED: open answer 1: level 2 (11 English words). STEP: OPEN QUESTION 2 of 3. …
system     [System] CUT OFF: The learner started talking while you were still speaking. They heard only:
           "You". They did not hear: "made tea in the morning! Who do you live with?" They were still answering
           your earlier question, "So, what did you do this morning?": everything they have said since it is
           ONE answer, in parts. This replaces what was recorded for its first part.
system     [System] STEP: OPEN QUESTION 1 of 3. You may stay for: help, something else.
user       and then I walked to the market                    ← only their new words
system     [System] MEASURED: 23 English words in the whole answer, all its parts together.
```

- **They heard her question** (or most of it): their words are a reply to it. The CUT OFF line says what they
  heard.
- **They cut in before her question**, right after an open answer: they were still answering. The CUT OFF line
  names the earlier question, and a new STEP line puts the talk back on it; the fixed instructions tell the AI to
  judge all the parts as one answer, and the app's word count covers all the parts. The app's own record of that
  answer (its level) is replaced by the new judgement, so it still counts as one answer to one question. The
  talk itself is not touched. A third part joins the same way.
- The fixed instructions tell the AI how to read the CUT OFF line: words they did not hear were never said, as
  far as the learner knows.

**The trade-off.** Before, the talk held only the words the learner heard, so the AI could not lean on anything
else. Now the unheard words are in front of it, marked as unheard, and it has to follow that mark. A model may
still behave as if they were heard: refer back to them ("as I asked"), skip a fix it thinks it already gave, or
ask a different question from the one it had planned without noticing. The CUT OFF line and the rule in the
fixed instructions point the same way to keep this rare, and stronger models follow it more reliably than small
ones; it is worth watching in real calls. What is gained: the talk is a true record of what she said, each
request is the last one plus new messages (the reusable part is never disturbed), and the code no longer edits
the past. A request with a cut-off is a little longer (her full turn and the app's lines).

## The AI's answer: as short as it can be

Output tokens are the dearest and the slowest part of a call, so the model is asked for the least it can write:
short keys, one letter for a value, and **nothing at all for what does not apply** (no `null`, no empty text).

| Key | Meaning | Values |
| --- | --- | --- |
| `h` | what happened (always) | `a` answered · `h` asked for help · `c` could not · `s` something else · `g` gave up |
| `p` | picture (that step only) | `y` named · `n` not named |
| `rd` | reading (that step only) | `w` well · `p` partly · `n` not |
| `lv` | level of an open answer | 1 to 4 |
| `ev` | why it judged so (only with `p`, `rd` or `lv`) | under 12 words |
| `tip` | the one fix it made | `["their words", "the right way"]` |
| `n` | their name, if they said it | |
| `r` | her reply (always) | |
| `q` | her question (left out when she finishes) | |
| `f` | the final level and feedback; its presence ends the talk | `{ lv, why, good: [..], next: [..], bye }` |

The hello turn, before and after:

```
before (11 fields, about 345 characters)       after (4 fields, about 125 characters)
{ "happened": "answered",                      {"h":"a","n":"Prajwal",
  "picture": null, "reading": null,             "r":"Nice to meet you, Prajwal.",
  "level": null, "evidence": "They gave …",     "q":"There's a picture on your screen. What is it called in English?"}
  "tip": null, "name": "Prajwal",
  "reply": "…", "question": "…",
  "finish": false, "final": null }
```

`server/placement/brain.js` reads the short answer back into full words (`repairTurn`) for the rest of the code,
the saved results and the Compare models page; `toWire` goes the other way. A model that ignores the format and
writes the long names, or nulls, is still understood.

**The trade-off.** A provider's own strict schema (OpenAI's structured output) makes the model write every field
every time: a field can be empty (`null`) but not absent. To leave fields out, the call asks for plain JSON
instead, and the format lives in the fixed instructions. So the provider no longer guarantees the shape; the
server checks every answer, repairs near-misses, and asks once more if it is still not usable (the Compare
models log shows when that happened: "the model was asked again"). The order of the keys also comes from the
instructions now, which is what lets her reply be picked out early while the answer is streamed.

## Speed: what makes a turn fast or slow

What the learner waits for, after they stop talking: speech-to-text finishing, then the AI's answer, then the
first sound of Sakhi's voice. For the AI's answer, in order of how much each matters:

1. **How hard the model thinks** (next section). Thinking happens before the first word of the answer, so it is
   pure waiting. `none` is the quickest; `low` is the setting.
2. **OpenAI's Fast mode** (Settings › Placement test › OpenAI speed; on by default). OpenAI serves the request
   up to 2.5 times quicker and more steadily, for about twice the price per token: for `gpt-6-luna` $0.2 / $0.02
   reused / $1.0 per million tokens against $0.1 / $0.01 / $0.5. The AI is the smallest part of what a talk
   costs, so this adds a few paise a talk. Only some models have it; a model without it, or a busy moment at
   OpenAI, answers at standard speed and price (the Compare models page shows which speed each call was really
   served at).
3. **How much the model writes**: the short answer format above.
4. **Reuse from cache**: a request whose beginning was sent before is read faster. See "How a turn is sent".
5. **Streaming**: Sakhi's voice is started as soon as her reply is written (see "Streaming").

To see where the time goes for a model, use **Compare models**: each call shows its whole time, when the first
words of the answer arrived (thinking and waiting in line come before that) and when her reply was ready. Add
the same model twice, with different thinking or speed, to compare. The app also says her
reaction while the rest of her turn is still being written (see "Streaming").

## How hard the model thinks

Two settings (Settings › Placement test), for models that take a thinking level (OpenAI's, Claude's; Sarvam and
Gemini ignore them):

- **Thinking on each turn**: `low`. The learner is waiting to hear Sakhi, so speed matters most.
- **Thinking for the final level and feedback**: `medium`. Care matters most.

Each can be `default` (the model's own: medium for `gpt-6-luna`), `none`, `low`, `medium`, `high`, `xhigh` or
`max` (the values OpenAI's `gpt-6-luna` takes). OpenAI gets it as `reasoning.effort`; Claude as its effort (it
has no "none": low is used; above high: high). A model that refuses a
thinking level is asked again without one, and that is remembered.

The level and feedback come in the answer to the last turn, so "the final evaluation" is that turn:
- When the app knows the turn is the last (the last open question allowed), that one call is made at the final
  level.
- When the AI itself ends the talk earlier, on a turn it thought about lightly, the same turn is asked **once
  more** at the final level, told to finish, and that answer is used (if it fails, the first one stands). This
  costs one more call and its wait, only at the end of such a talk. The request is the same with one line more at the end
  ("Finish now"), so nearly all of it is reused from cache. Set both settings the same to never make the second call.

On the **Compare models** page each OpenAI or Claude model has its own two choices, starting at the settings'
levels, so thinking levels can be tried without changing what learners get. Add the same model twice to compare
two levels side by side (the columns are named "… · thinking none/medium"). The page shows the thinking level on
every call and lists the second call in the log; "Use this model for the placement test" saves the chosen
levels with the model.

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
joins it from its first byte (a line being made is shared, never made twice).

**The app says her reaction while the rest is still being written.** The Android app asks for the turn in parts
(`Accept: application/x-ndjson` on `POST /api/session/turn`). The server then answers one JSON object a line:

```
{"part":"reply","say":[ her reaction's lines ]}        the moment they are known (not on every turn)
{"part":"turn", ... the whole turn, as always ... }     its lines begin with the ones already sent
```

The app starts saying the reaction at once, shows the "…" bubble if the rest is still coming, and carries on
with the remaining lines when the whole turn arrives. Once her reaction has been sent it **is** her reaction
for that turn: if the rest of the model's answer changes its mind, has to be asked for again, or fails, the
server keeps to what she is already saying and takes only her question (or the fixed line) from what follows.
If the learner talks over the reaction, the app waits for the whole turn (it needs to know what comes next) and
then listens; their words are kept from the moment they started.

What it saves: on an ordinary turn, the time the model spends writing her question; on the last turn, the time
it spends on the level and feedback, and the whole of the second, more careful evaluation when there is one
(she says "That sounds lovely." straight away, and the level follows).

An app build from before this, and any app that does not ask, gets the whole turn as one JSON answer, exactly
as before; and the new app works with a server from before this. So the server and the app can be released in
either order.

What this buys, per turn: roughly the time the model spends on everything after the reply (short on an ordinary
turn; a second or more on the last turn, where the level and feedback are written), up to the time her voice
takes to start. The model's thinking before it writes anything is not shortened by streaming: that is what the
thinking level above is for.

Her **question** no longer waits either: the app asks for one line at a time, as it reaches it, so the question
used to start being made only after the reply had been played, and she paused between the two. The server now
starts the voice for every line of the turn as soon as the turn is known; by the time the app reaches a line
it is ready. (If the learner talks over her first line, the lines after it were made for nothing: a few
characters of voice.)

Why not feed the voice word by word, as the model writes? Her reply is one short sentence, written in a fraction
of a second, so there is little to gain; a voice needs a whole clause to sound natural; and the checks on what
she may say (no question in her reply, never the picture's word, no invented name) need the whole sentence.

Limits, so nobody is surprised:
- The web client (the team's test page) still takes the whole turn at once; only the Android app plays her
  reaction ahead.
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

   Gemini needs no key: by default it goes through **Vertex AI**, so Google Cloud credits (the $300 free trial)
   pay for it. Those credits can't pay for the Gemini API (AI Studio) key; the models and names are the same.
   `deploy/cloudrun.sh` sets it up; for a server deployed before that, run once:

   ```bash
   PROJECT=cool-arch-515210-b0 ./deploy/vertex-setup.sh
   ```

2. **Admin console › Compare models**: pick up to four models (it starts with the model in use beside OpenAI's
   `gpt-6-luna`). Each runs its own conversation, side by side, from the hello to the level and feedback; they
   all start with the same picture, line to read and first open question.
   - **Type or speak.** The box at the bottom replies to **all** the conversations still going. Each
     conversation also has its own box and buttons (says nothing, skips, asks for Hindi, Speak) for a reply to
     that one **only**, from the first turn. After that the conversations may be on different steps; a reply to
     all still goes to each, wherever it is.
     **Speak** records from your microphone (up to 30 seconds) and Sarvam turns it
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
- **Gemini through Vertex AI** (the default; `GOOGLE_GENAI_USE_VERTEXAI=false` switches it off): the same
  request goes to Vertex AI's OpenAI-compatible endpoint
  (`aiplatform.googleapis.com/v1/projects/<project>/locations/<location>/endpoints/openapi`), the model named
  `google/<model>`, signed in as the server's service account (`roles/aiplatform.user`) instead of with a key.
  Billed to the Google Cloud project, so its credits apply. `GOOGLE_CLOUD_LOCATION` is `global` unless set (the
  newest models are there first). The model menu comes from Vertex AI's model list. The console shows
  "Gemini (Vertex AI)" while it is on; `OFF=1 ./deploy/vertex-setup.sh` switches back to the key. Gemini shows as
  set up even where the server can't sign in to Google Cloud (a laptop without `gcloud auth application-default
  login`): the first call then says so. Prices are taken
  as the same as the Gemini API's. Only the chat models move: Google Cloud TTS voices were already billed to the
  project.
- None of the three has been run against the real service from this repository (no keys here): the tests use
  stand-ins. Try each on the Compare models page before switching learners to it.
- Cost shown is an estimate (Sarvam, Claude, OpenAI and Gemini prices are known to the code; others show "–").
- **Gemini**: every chat model and its price is listed (Google's price page, 23 Nov 2026, including the rises
  Google has announced: Gemini 4 Carbon and Argon double on 1 Dec 2026, 3.8 Flash on 1 Jan 2027; the right price
  is used for the day of the call). Thinking levels map to Google's: thinking can be turned off only on the 2.5
  models ("none" is their least level otherwise), and extra high exists only on Gemini 4 Neon and Hydrogen. Spending on
  providers other than Sarvam is not counted towards the daily budget limit yet.
- **Privacy**: with a provider other than Sarvam, the text of what learners say is sent to that company's
  servers, outside India. The privacy policy needs to say so before learners are switched to one. Voice
  recordings and speech-to-text stay with Sarvam.

## How a turn is sent to the AI

One request per learner turn, the same for every provider. It is built so that a provider can reuse ("cache")
nearly all of it, at a lower price, and only what is truly new is paid for in full:

1. **Every rule is in the fixed instructions**, the same in every request of every talk: how Sakhi talks, the
   four steps, what to do for each thing that can happen at each step, the levels, the answer format. About
   2,600 tokens, reused from the very first turn of a talk (other learners' talks have already sent them).
2. **The talk only ever grows.** Whatever the app has to tell the AI about this learner, it says once, in a short
   line of its own, and that line stays in the talk for good. Nothing is sent for one request only and nothing is
   rewritten later, so each request is the one before it, whole, plus what is new.

```
system     Sakhi's fixed instructions
user       (The call begins.)
assistant  Hi, my name is Sakhi. What is your name? …
system     [System] STEP: HELLO. You may stay for: help, something else.
user       My name is Ravi
assistant  Nice to meet you, Ravi! There's a picture on your screen. What is it called in English?
system     [System] STEP: PICTURE. The picture on their screen shows: house (also right: home). You may stay for: …
user       It's a house
assistant  Yes, a house! Now there's a line on your screen. Could you read it out?        ┐ new in this
system     [System] RECORDED: picture named. STEP: READING. The line on their screen …  │ request: not
user       Yesterday I went to the market …                                               │ yet reusable
system     [System] MEASURED: about 10 of the line's 11 words are in their reply.        ┘
```

The "[System]" lines are written by the server (not by the phone app; the learner never sees or hears them):
- **STEP**, after each of Sakhi's turns: the step the learner is now answering; what she needs for it (the
  picture, the line to read), told when the step begins and not before; what the app **RECORDED** from the turn
  just judged (picture named, reading well, the level of an open answer); and what she may still stay on the
  step for (help twice, something off the point once). The last open question says so.
- **MEASURED**, after the learner's reply to the reading and to open questions: the one thing the server
  counted in it (how many of the line's words, how many English words). Nothing is measured for the picture: the
  model sees the word in their reply for itself.
- **CUT OFF**, when they talked over her (see above).

**What can and cannot be reused.** A provider can only reuse what it has already been sent. So in each request
four things are new: Sakhi's last words (the model wrote them, but they were never sent to it), the app's STEP
line, the learner's reply, and the MEASURED line: a few dozen tokens beside the learner's own words. Everything
before them is the previous request, exactly. On the next turn those four are part of what is reused.

*Before this*, each request ended with a long note for that turn (the step, the facts, and five lines of "what to
do", about 250 to 300 tokens). It was new every time and thrown away afterwards, so it was never reused: that
is why the Compare models log always showed it as "new". Its rules are now in the fixed instructions; its facts
are the short lines above.

**What this asks of the model.** The app no longer repeats, each turn, what to do for each thing that can
happen: the model reads the rule in its instructions and the latest STEP line. The app still decides the step
and enforces the limits whatever the model answers (a model that tries to stay on a step once too often is moved
on), and still falls back to its own checks when a judgement is missing. If a model does lose the thread, it
shows as Sakhi asking about the wrong step; watch for it when trying a new model on the Compare models page.

OpenAI gets exactly this through its **Responses API** (`POST /responses`, `input`, `store: false`), the app's
lines as system messages. Claude, Gemini and Sarvam take system messages only at the start, so for them the
app's lines go in as user messages (they are marked "[System]" either way); Claude is also told to cache the
repeated part. The Compare models page shows how many input tokens were reused on each turn, and marks each
message as reused or new (an estimate: providers report only the count). Caching only starts once a request is
long enough (about a thousand tokens for OpenAI); the fixed instructions alone are longer than that. The
goodbye, level and feedback come in the last turn's answer: no extra request.

## The result screen: feedback on their own answers

Under the level, the app shows what the learner can learn from what they actually said
(`server/placement/insights.js`, `android/.../ui/ResultScreen.kt`). Every part is there to try out; Prajwal will
keep the ones that work best:

| Part | What it shows | Made by |
|---|---|---|
| Your best moment | their strongest sentence, quoted, with tags (gave a reason, joined two ideas…) | the AI; kept only if the quote is in their words |
| Your answers, polished | each answer with the wrong words struck out and Sakhi's version highlighted, and why | the AI writes the version; the app works out the word-by-word difference |
| Next level (a toggle on the same card) | the same idea the way a speaker one level up would say it, with labels for what it adds | the AI |
| How each level would say it | one idea of theirs said at levels 1 to 4; theirs marked "You are here" | the AI |
| One habit to work on | a mistake seen in two or more places, each example fixed, and a rule | the AI; kept only with two examples in their words |
| A tip for you | a common Indian English pattern they used ("since two months"), with a Hindi line | the AI; kept only if they said it |
| What you said, counted | English words, the longest answer, joining words, Hindi words | the app (no AI) |
| Hear it / Say it | Sakhi says a sentence; the learner says it back and sees which words were heard | Sakhi's voice; Sarvam speech-to-text and the app's word match |

It is written in **one extra AI call** (the model of each turn, Settings › Placement test, with the final
evaluation's thinking), started the moment the test ends, while Sakhi says goodbye, so her last turn is not
slower. The app asks `GET /api/session/insights?id=…`, which waits for it (about 25 s at most), and shows "Sakhi is
writing feedback on your answers…" until then. If the AI fails, only the counts are shown, with the older "What
went well" card, which stays below. `POST /api/session/sayback?id=…&text=…` takes a WAV of the learner saying one
of its sentences (only those) and returns each word, heard or not. It works for both kinds of test (the classic
test's spoken answers too). The feedback lives with the test in memory; it is not saved to the database yet.

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
