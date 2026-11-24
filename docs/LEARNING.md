# The learning module: tutor runtime, corrections, progress, admin console

After the placement test, learners practise with Sakhi: **free conversation** (any topic, corrected gently as they
go) and **lessons** (explain → examples → exercises → feedback → next). This document covers how it works, why it
is built this way, how to run and test it, and what is still open.

## In one picture

```
 app ──POST /api/learn/conversations/:id/messages──▶ server/learning/api.js   (phone login, ownership, limits)
                                                         │
                                                         ▼
                                          runtime.respond()  server/learning/runtime.js
   1. check input (Zod) · conversation belongs to the learner
   2. same clientMessageId already answered? → return the stored answer (nothing runs twice)
   3. save the learner's message · gather context: profile, memory, recent messages, lesson
   4. tutor turn  server/learning/tutor.js
        prompt (prompts.js, versioned sections) ─▶ AI provider layer (server/llm) ─▶ validated TutorOutput
        └─ reply ──────────────▶ sent to the app at once (stream event "reply")
        └─ corrections ─▶ correction policy (corrections.js) ─▶ [strategy B] the check (verifier.js)
                                                             ─▶ stream event "corrections"
   5. one transaction: the reply, the corrections shown, learning evidence, derived skills (repo.js)
   6. level estimate updated from the evidence (progress.js)
```

## Files

| Path | What it does |
|---|---|
| `server/learning/runtime.js` | `respond()`: the single entry point for a learner's message (free practice or a lesson) |
| `server/learning/tutor.js` | One tutor turn without saving: prompt → AI → policy → check. Shared by the runtime, the admin playground and evaluations, so all three behave alike |
| `server/learning/prompts.js` | The prompts, built from small sections (identity, learner, mode, lesson, correction intensity, context, response format), with `PROMPT_VERSION` recorded on every reply and evaluation |
| `server/learning/corrections.js` | The correction policy (pure functions) |
| `server/learning/verifier.js` | Strategy B's check, and matching its decisions to corrections |
| `server/learning/schemas.js` | Zod schemas for everything the AI returns, and repairs for near-miss labels |
| `server/learning/repo.js` | Database access: profile, memory, messages, evidence, skills, level, progress |
| `server/learning/memory.js` | Sakhi's memory of each learner across conversations: memory notes, recall for the prompt, the personal greeting, forgetting |
| `server/learning/progress.js` | Mastery and level estimation from evidence (pure functions) |
| `server/learning/lessons.js` + `shared/lessons.json` | Lessons: content, sync to the database, sessions, marking |
| `server/learning/api.js` | `/api/learn/*` |
| `server/learning/eval.js`, `evalRuns.js`, `scripts/eval-corrections.js`, `shared/eval/corrections-v1.json` | Correction-quality evaluation |
| `server/llm/` | The AI provider layer: Sarvam (default), OpenAI (optional) |
| `server/settings.js` | Live settings the admin console changes, with an audit trail |
| `server/admin/api.js`, `public/admin/` | The admin console |
| `server/http.js` | Request ids, JSON logs, small HTTP helpers |
| `server/db/migrations/002_learning.sql`, `003_learning_guards.sql` | The schema |

## Decisions, and why

- **A small custom runtime, not an agent framework.** A tutor turn is a fixed pipeline (context → one model call →
  rules → optional check → save). There's no open-ended tool use or planning that a graph framework would help with,
  and a plain function is easier to test, retry safely and reason about. Node.js stays (the rest of the server is
  Node); **Zod** plays Pydantic's role.
- **Sarvam by default; other providers optional.** Every AI job (`tutor`, `verify`, `lessonEval`) has its provider,
  model and temperature in the admin settings. OpenAI can be chosen only when `OPENAI_API_KEY` is set on the server
  (the console refuses otherwise); if a chosen provider isn't configured, the job falls back to Sarvam. OpenAI uses
  strict structured outputs generated from the same Zod schemas. *The OpenAI path is not tested against the live
  API (no key here).*
- **Precision over recall.** Correcting valid English is worse than missing a slip: it teaches the wrong thing and
  erodes trust. Every rule below leans that way, and evaluations report precision and false alarms first.
- **Reply first, corrections after.** The conversation never waits for corrections: the reply is streamed as soon as
  the tutor answers; checked corrections follow a moment later as a separate, quiet card.
- **Voice-safe corrections.** For spoken messages, speech-to-text often drops articles and endings. Corrections that
  only add or remove a/an/the, -s/-es/-ed, capitals, punctuation or spelling are not shown for voice (admin switch).
- **Evidence, not impressions.** Raw evidence (`learning_events`: mistakes, correct uses, exercise answers) is kept
  apart from what's derived from it (`learner_skills`, the level estimate), so the maths can improve and be recomputed.
- **Extend the existing schema.** Same database, same `users`; a learner's learning data is erased with them.
- **Prompt examples are kept apart from the evaluation set**, so evaluations measure the rules, not memorised answers
  (an early version leaked; see the evaluation history).

## The correction policy (`corrections.js`)

Applied to every correction the AI proposes, in order:
1. The original words must appear in what the learner said (no invented mistakes) and the fix must change something.
2. Voice: drop anything a speech-to-text slip could explain (see above).
3. Intensity, chosen by the learner (default set by the admin):
   **gentle** — only `important` mistakes (meaning is wrong or unclear), grammar/vocabulary/word order, 1 per reply;
   **balanced** — `moderate` and up, 3 per reply; **strict** — everything, 5 per reply (limits are admin settings).
4. Overlapping corrections of the same words: keep the more important one.
5. Most important first, up to the limit.

Then, with **strategy B**, the check gives each remaining correction a verdict — `real_mistake` (shown),
`not_a_mistake` or `bad_fix` (not shown). If the check fails, corrections are withheld but the reply still goes out.
Learning signals ("used the past tense correctly") only count when their evidence is the learner's own words.

## A vs B: the side-by-side comparison

**A** = one call (reply + corrections), corrections filtered by the policy.
**B** = the same call, plus a check of the corrections — made only when there are any.
Both are scored on the **same** first call, so the only difference is the check.

Dataset: `shared/eval/corrections-v1.json`, 74 hand-labelled learner messages — tense, irregular verbs, agreement,
articles, prepositions, word order, vocabulary, beginner and advanced, spoken (speech-to-text style), and 31 messages
with **nothing to correct** (informal English, Indian English vocabulary, standard English, ambiguous cases). Each
run below sends every message twice (148 turns), Sarvam-105B for both calls, balanced intensity.

**Result (runs 3 and 4 combined, 20 Nov 2026, prompt `tutor-v3`: 296 turns):**

| | A · one call | B · one call + check |
|---|---:|---:|
| Precision (right ÷ shown) | 93.9% | **96.5%** |
| Correct messages that got a correction anyway | 7.3% (9 of 124) | **3.2%** (4 of 124) |
| Recall (corrected ÷ real mistakes) | **96.0%** | 93.2% |
| F0.5 (precision counts double) | 94.3% | **95.8%** |
| Right / false / missed | 169 / 11 / 7 | 164 / 6 / 12 |
| Reply reaches the learner, typical | 0.89 s | 0.89 s (same: reply first) |
| Corrections reach the learner, typical / slowest 5% | 0.89 s / 1.37 s | 1.56 s / 2.35 s |
| AI cost per message | ₹0.0185 | ₹0.0274 (+48%) |
| Failed turns | 0 | 0 |

Run by run, B's lead varies: in run 3 it had 1 false alarm to A's 5; in run 4, 3 to A's 4 (the check accepted
"costly → expensive" and "on Sundays → on Sunday" in run 4 that it had stopped in run 3). Where B helps: false
corrections of Indian English vocabulary ("prepone", "costly") and of correct standard English (a second conditional
"had" → "have"). What it costs: some real corrections the check wrongly rejects ("When I was child", "the amount of
people", "open the light"). B's check ran on 62% of turns in this error-heavy set; real conversations have fewer
mistakes, so the real cost increase will be smaller. At 1,000 practice messages a day: A about ₹19, B about ₹28.

**Recommendation: B** (already the default), with honest confidence: it roughly halves wrong corrections for about
3 points of recall, and learners don't wait longer for the reply; the evidence favours it but the margin (9 vs 4
messages) is not yet conclusive. Keep measuring: grow the set from real learner messages, watch "stopped by the
check" on the dashboard, and switch to A in Settings if real data shows the check costing more than it saves.

**Caveats.** 74 messages is small: one or two messages move a percentage by several points. The labels are one
person's judgement (Indian English usage especially). Sarvam's answers vary between runs (A's false-alarm rate ranged
from 3.8% to 11.3% across runs), which is why runs 3 and 4 are combined.

**History** (all in `docs/eval/`, re-scored with the final scorer):

| Run | Prompt | A precision / recall | B precision / recall | Notes |
|---|---|---|---|---|
| 1 | tutor-v1 | 95.8 / 98.6 | 98.3 / 82.9 | 28 of 148 turns failed (Sarvam rate limits at concurrency 4; labels outside the list). The check over-applied "Indian English is fine" to grammar errors |
| 2 | tutor-v2 | 90.5 / 97.7 | 98.4 / 69.3 | Fixed failures (repairs, retries, concurrency 2). **Not valid:** the check's examples were taken from the evaluation set, and its `keep` flag was read backwards ("this is a definite grammar error" → keep: false) |
| 3 | tutor-v3 | 93.3 / 95.5 | 97.6 / 93.2 | Explicit verdicts, decisions matched by the quoted words, examples kept apart from the set |
| 4 | tutor-v3 | 94.4 / 96.6 | 95.3 / 93.2 | Same prompts; the check is asked again about corrections it skipped (it sometimes stopped after the first) |

Run it yourself: `npm run eval` (about ₹2; add `-- --repeat 2` for steadier numbers), or **Evaluations** in the admin
console. `npm run eval -- --rescore <file>` re-scores saved results without calling the AI.

## Lessons

Eight starter lessons in `shared/lessons.json` (past simple, irregular past, he/she + -s, a/an/the, in/on/at for time,
questions with do/does, work vocabulary, present perfect for experiences), synced into the database at start; changed
content becomes a new version (a session keeps the version it started on). Flow: the explanation and examples come
from the file (no AI needed); each exercise is marked **exactly** when possible (accepted answers, a choice by text,
number or letter, a fill-in given as the whole sentence), otherwise by the AI (`lessonEval`). A wrong first answer
gets a hint (not the answer) and one more try; then the answer and its explanation are shown and the lesson moves on.
Every answer is learning evidence. Each lesson session also has a conversation, so the learner can ask Sakhi about it.

## Memory and progress

- **Short-term:** the last N messages of the conversation (admin setting, default 10).
- **Learner profile:** name, goals, correction intensity, support language (Hindi for hard explanations), placement level.
- **Learner memory** (below): what the learner has told Sakhi across conversations, and what past conversations were about.
- **Learning memory:** concepts the learner keeps getting wrong (≥2 mistakes, not mastered), concepts explained in the
  last day (so Sakhi doesn't repeat a full explanation), and facts from the placement conversation.
- **Mastery per concept** (`progress.js`): recent evidence weighs more (each older item 0.85×), starting neutral;
  "mastered" needs ≥5 correct uses, mastery ≥0.8 and no mistake in the last three; "practising" ≥2 correct and ≥0.5.
- **Level estimate:** starts at the placement level; moves one step only with ≥80 scored answers in 30 days
  (≥85% right → up, ≤40% → down), at most once per 14 days; recorded in `level_history` (source `practice`).
  These thresholds are a reasoned start, not yet calibrated against real learners.

## Learner memory (Nov 2026)

Sakhi remembers each learner across conversations (`server/learning/memory.js`, migration `010_learner_memory.sql`).
The ideas and choices behind it: [Sakhi's memory of each learner: ideas](https://claude.ai/artifact/7CexmLNLBuees6rrVtP2md).

- **What is kept:** short English notes in `learner_memories`, each a `fact` (work, city, family), `goal`, `event`
  (with a date, so Sakhi asks how it went), `interest` or `preference` (how they like to learn), with importance 1–3;
  and a one- or two-sentence `summary` + `topics` on each practice conversation. Text only, no audio. Facts from the
  placement test go in too (`store.addConversationFacts`), and the migration copied in those saved before.
- **How it's written:** a background *memory note* (AI job `memory`, admin › AI models) reads the messages since the
  last note and what's already known, and returns what to add, update, forget or mark done, plus the summary. It runs
  after every N learner messages (admin setting, default 8), at once when the learner says "forget" (or "bhool jao"),
  and for earlier unread conversations when a new conversation starts. It never delays a reply.
- **Never kept:** health, religion, caste, politics, money, love life, contact details: the prompt forbids them and
  `sensitive()` drops anything that slips through. "Forget everything" from the AI is honoured only when the
  learner actually said "forget".
- **How it's used:** every tutor turn gets the most useful items (`inPrompt`, default 12), coming and past events,
  and the summaries of the last conversations (`pastConversations`, default 2), with rules: at most one memory per
  reply, never recite them, believe the learner if something changed. A new conversation opens with a personal
  greeting from memory (one small AI call; the plain greeting if nothing is remembered or it fails). An event asked
  about is marked done. Past the limit (`maxItems`, default 40) the least important old items fade.
- **The learner's control:** `GET /api/learn/memory` (items and past conversations' summaries),
  `DELETE /api/learn/memory/:id`, `DELETE /api/learn/memory` (everything, including the placement facts),
  `PATCH /preferences {memoryEnabled}`. Account deletion removes it all (on delete cascade).
  The app screen for this ("What Sakhi remembers") is not built yet.
- **Admin:** Settings › Sakhi's memory of learners: on/off (off = practice works exactly as before), how often,
  limits, personal greeting, and how long summaries are kept (default 365 days, cleaned daily).
- **Still to do:** the app screen and switch; a privacy policy line ("Sakhi keeps short notes about what you share
  to personalise practice; you can see and delete them in the app"); the placement test reading memory on a retake.

## API (`/api/learn`, phone login required)

| Method and path | Body → result |
|---|---|
| `GET /profile` | name, correctionIntensity, goals, supportLanguage, level, placementLevel, levelConfidence, memoryEnabled |
| `PATCH /preferences` | `{correctionIntensity?, goals?, supportLanguage?, memoryEnabled?}` |
| `GET /memory` · `DELETE /memory/:id` · `DELETE /memory` | what Sakhi remembers · forget one · forget everything |
| `GET /progress` | level, activity counts, skills, focus (top 3 to practise) |
| `GET /conversations` · `POST /conversations` | list · new free-practice conversation with Sakhi's greeting |
| `GET /conversations/:id` | messages with their corrections |
| `POST /conversations/:id/messages` | `{message, channel: text\|voice, clientMessageId?, sttConfidence?}` → `{reply, corrections, replayed, meta}`. With `Accept: text/event-stream`: events `reply`, `corrections`, `done` (or `error`) |
| `GET /lessons` · `GET /lessons/:id` · `POST /lessons/:id/start` | lessons with progress · one lesson · start or resume |
| `GET /lesson-sessions/:id` · `POST /lesson-sessions/:id/attempts` | state · `{exerciseId, answer, channel?, clientAttemptId?}` → verdict, feedback, tryAgain, next state, summary |
| `POST /voice/transcribe` | 16 kHz WAV ≤30 s → `{text, languageCode}` |
| `POST /messages/:id/speech` | Sakhi's voice for one of her own replies (PCM stream) |

Errors: `{error, reason?, requestId}` with 400 (input), 401 (login), 404 (not found or not yours), 409 (a doubled
request still in progress, or a stale exercise), 429 (daily limit), 502 (the AI failed; retry with the same id),
503 (switched off, over budget, or no database). Every response carries `x-request-id`.

Retries are safe: a message or exercise answer sent again with the same client id returns the stored result; a
reply is saved at most once per learner message (database constraint), together with its corrections and evidence.

## The admin console (adamspeaks.in/admin; `/admin/` locally)

Sign in with a phone number on the admin team (the test and demo numbers are never accepted). Pages:
**Overview** (learners, activity, reply times, spend vs budget, 14-day charts, placement levels, common mistakes,
corrections stopped by the check) · **Settings** (AI models per job, correction strategy and intensity, limits and
budget, features, placement cut-offs; validated, applied within seconds without a deploy, every change recorded with
who made it) · **Playground** (a message through A and B side by side, nothing saved) · **Evaluations** (start a run,
compare, see every message where A and B differ) · **Conversations** (transcripts with corrections shown and not
shown, timings, cost; phone numbers partly hidden) · **Lessons** (started, finished, average score) · **Team**
(people and roles).

### Team and roles (`server/admin/team.js`)

People sign in with their phone number; their **role** decides what they can do. The server checks the permission
on every request (the console only hides what a role can't use), and changes apply at once.

| Role | Can |
|---|---|
| **Owner** | Everything, including the team. The numbers in `ADMIN_PHONES` are always owners (changed only there). |
| **Admin** | Everything except the team |
| **Analyst** | Dashboard, lessons, settings and evaluations, read only |
| **Support** | Dashboard, learners' conversations, lessons |
| *Your own* | Any mix of the permissions below (Team › New role) |

Permissions: see the dashboard · read learners' conversations · see lessons · see settings · change settings · use
the playground · see evaluations · start evaluations · manage the team.

Rules: only owners add, change or remove owners; someone who manages the team without being an owner can't give
out (or take away) permissions they don't have; nobody changes their own access; built-in roles can't be deleted
and the Owner role can't be changed; the test and demo numbers can never be on the team. Paused or removed people
lose access on their next click. Every team change is recorded (Team › Team changes).

Setup on Google Cloud: `deploy/admin-setup.sh` (see `deploy/README.md`). Locally (no login) it's open at
`http://localhost:3000/admin/`.

## Settings (`server/settings.js`, table `app_settings`, history in `settings_audit`)

`llm` (tutor / verify / lessonEval: provider, model, temperature) · `corrections` (strategy single|verify, default
intensity, voice-safe, max per reply per intensity) · `conversation` (recent messages read) · `limits` (daily budget,
placement tests per hour, turns and listening per test, practice messages per learner per day) · `features`
(learning module on/off) · `scoring` (placement cut-offs and judge weights). Values are refreshed from the database
every 30 s on each server; changes from the console apply at once on the server that made them.

## Environment variables (new)

| Name | Meaning |
|---|---|
| `OPENAI_API_KEY` | Optional. Lets the console choose OpenAI for an AI job. Put it in Secret Manager, never in a file |
| `OPENAI_BASE_URL` | Optional. Another OpenAI-compatible endpoint |
| `ADMIN_PHONES` | Comma-separated phone numbers that are always owners of the admin console (`+91…`); add others on the Team page |
| `SAKHI_LEARN_MESSAGES_PER_DAY` | Default for the per-learner daily limit (admin setting wins) |
| `SAKHI_SKIP_WARMUP=1` | Local development: don't pre-generate the placement test's voice lines at start |

## Running locally

1. A database:
```bash
docker run -d --name sakhi-pg -e POSTGRES_PASSWORD=dev -p 127.0.0.1:5432:5432 postgres:16
```
2. Create the databases (one for the server, one for tests):
```bash
docker exec sakhi-pg psql -U postgres -c "create database sakhi" -c "create database sakhi_test"
```
3. Start the server (`.env` with `SARVAM_API_KEY`; tables are created at start):
```bash
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/sakhi SAKHI_SKIP_WARMUP=1 npm run dev
```
4. Open `http://localhost:3000/admin/`, or call the API (without login, everything belongs to one local learner).
5. Tests (mocked AI; the database tests run when `TEST_DATABASE_URL` is set, as in CI):
```bash
TEST_DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/sakhi_test npm test
```

## Tests

132 server tests pass: correction policy, progress maths, exact marking, prompts, repairs, decision matching, the
tutor turn with a mocked AI (A, B, a failing check, comparison), the scorer and the dataset's shape
(`test/learning-unit.test.js`); the runtime and lessons against PostgreSQL — retries, concurrent duplicates, AI
failure and resume, ownership, memory reaching the prompt, intensity, the daily limit, lessons start to finish,
erasure (`test/learning.test.js`); the HTTP API and admin console — login, streaming order, admin phone list, settings
validation and audit, playground (`test/learn-api.test.js`). Live AI quality is measured separately by evaluations.

## Limitations and next steps

- **The Android app** uses the learning module (Nov 2026): practice chat (typed or spoken, Sakhi's reply first, the
  correction card a moment later, her voice on request), lessons (explanation, examples, exercises with feedback and a
  second try) and progress, in `android/app/src/main/java/com/sakhi/app/learn/` and `ui/LearnScreens.kt`. Not yet:
  editing goals or the support language, a full skills page, and live streaming speech for practice.
- Spoken practice uses one recording per message (`/voice/transcribe`, ≤30 s). Live streaming speech like the
  placement test can come later.
- Pronunciation feedback is out of scope (kept separate on purpose); the placement test still scores it.
- The evaluation set is small and single-labeller; grow it from real messages. Lesson marking has no evaluation yet.
- Level and mastery thresholds need calibration against real learners.
- Daily spend is counted per server instance in memory (fine with one instance).
- The check adds about 0.6 s before corrections appear and about 49% AI cost on error-heavy traffic.
- OpenAI support is untested against the live API.
