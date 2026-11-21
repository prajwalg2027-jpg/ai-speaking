# Adam — handoff for a new Claude session

Read this first. It says what exists, where it runs, how to release and check it, and what's pending.
Work on the branch **`tutor-conversation`** (never push to `main`). Last updated 19 Nov 2026.

## How to work with Prajwal (the founder)

- Explain in **simple, non-technical words**; give **step-by-step** instructions and one ready-to-paste
  command per code block. Prefer doing things yourself over asking him to.
- Never ask him to paste secrets (keys, passwords) into chat; secrets go into Secret Manager or the
  environment's settings by him.
- Commit messages end with the attribution lines your session gives you; never put a model name in commits.
- Commit and push finished work. Run the tests first.

## What Adam is

A voice-first English **placement test** for Indian learners, as an Android app. The tutor inside is called
**Sakhi** (female voice, Hindi-first, moves to English as the learner gains confidence); the app and brand are
**Adam** (`adamspeaks.in`). Speech, voice and AI are all **Sarvam** (Saaras v4 realtime STT, Bulbul v4 Flash
voice, Sarvam-105B). The server holds the Sarvam key and all conversation logic; the app only talks and listens.

## What runs where

| Thing | Where |
|---|---|
| Google Cloud project | `cool-arch-515210-b0` ("My First Project", number 209464958247), region `asia-south1` (Mumbai) |
| Server | Cloud Run service `adam`: `https://adam-nfgw4g4xwa-el.a.run.app` (one always-on instance) |
| Database | Cloud SQL PostgreSQL 16 `adam-db`, database `adam`, user `adam` (URL in Secret Manager `adam-database-url`) |
| Voice recordings | bucket `cool-arch-515210-b0-adam-recordings` (private, no soft delete; kept until erasure) |
| Sakhi's fixed voice lines | bucket `cool-arch-515210-b0-adam-voice` (saves ~₹15 per server start) |
| Secrets | Secret Manager: `sarvam-api-key`, `adam-database-url` |
| Server's account | `adam-runtime@cool-arch-515210-b0.iam.gserviceaccount.com` (only these resources) |
| Phone login | SMS OTP through MSG91, sent and checked by the server, then the server’s own sessions (`server/login.js`, `docs/LOGIN.md`; setup `deploy/msg91-setup.sh`). Firebase logins from older builds are still accepted |
| Android apps | `in.adamspeaks.app` (release), `in.adamspeaks.app.dev` (test build; shared signing key `android/app/debug.keystore`) |
| Website | `adamspeaks.in` on Firebase Hosting, built from branch `claude/dazzling-cray-ni75q7` folder `website/` (DNS at GoDaddy) |
| App settings file | `https://adamspeaks.in/app-config.json` (server address, minimum app version; the app reads it at start) |

## Releasing and checking

- **Release the server from GitHub** (no upload needed; works from a connector or Cloud Shell):
  `gcloud builds submit https://github.com/prajwalg2027-jpg/ai-speaking --git-source-revision=tutor-conversation --config=deploy/cloudbuild.yaml --region=asia-south1 --project=cool-arch-515210-b0`
- **Full setup / infrastructure changes:** `deploy/cloudrun.sh` (idempotent; see `deploy/README.md`).
- **Login setup:** `deploy/msg91-setup.sh` (MSG91 widget id, authkey into Secret Manager, admin numbers). Older: `deploy/firebase-setup.sh`.
- **Start-up log:** `gcloud run services logs read adam --region=asia-south1 --project=cool-arch-515210-b0 --limit=50`
  (look for `Pre-generated … (124 from the voice store, 0 new)`).
- **Health:** `GET /api/health` (Cloud Run reserves `/healthz`).
- **Data:** Cloud SQL Studio on `adam-db`. Tables: `users` (flexible `attributes` jsonb; allowed keys in
  `attribute_definitions`), `attribute_history`, `consents`, `assessments`, `assessment_answers`, `recordings`,
  `level_history`, `events` (transaction log), `erasures`. Migrations in `server/db/migrations`, applied at start.
- **Android:** `cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`. Test APK goes to
  Prajwal as a file; he installs it on his phone (no adb). Release bundle via CI once signing secrets exist.
- **Tests:** server `npm test` (database tests need `TEST_DATABASE_URL`); CI runs everything on push.

## Production rules (server/guard.js, server/auth.js)

Phone login required on every request and on the live speech socket; consents (terms, privacy, 18+, recordings)
before a test; limits per address and per conversation; daily Sarvam spend cap ₹3,000 (`SAKHI_DAILY_BUDGET_INR`);
team tools (question review, cut-off editor, STT lab) are off in production — use `npm start` locally.
A shared "team pass" that bypasses login was refused by the safety check; don't build one.

## Learning module and admin console (Nov 2026)

Practice conversations and lessons with personalised corrections, learner memory and evidence-based progress, plus
an admin console at **adamspeaks.in/admin** (dashboard, live settings, playground, evaluations). Everything is in
`docs/LEARNING.md`, including the A vs B comparison (runs 3+4, 296 turns): **B (one call + a check of corrections) is the default**:
precision 96.5% vs 93.9%, wrong corrections on correct English 3.2% vs 7.3%, recall 93.2% vs 96.0%. The Android
app doesn't use the learning API yet. Admin setup on Google Cloud: `deploy/admin-setup.sh` (not yet run).
Keep prompt examples apart from `shared/eval/` sentences, or evaluations stop meaning anything.

## Payments (Nov 2026)

The score is free; "Start learning" opens a ₹299/month subscription through Razorpay (`docs/PAYMENTS.md`). The
server decides access (signatures checked, state from Razorpay); test and live mode are kept apart. Razorpay is for
sideloaded builds now; **before the Play release**, add Google Play Billing with user choice billing (the plan is in
`docs/PAYMENTS.md`). Setup: `deploy/razorpay-setup.sh` (test keys first).

## Before production (Prajwal asked: remove these at launch)

- **The test build download page** (`adamspeaks.in/internal/<token>`, pre-production only). Every push to
  `tutor-conversation` or `main` uploads the debug APK there. Remove it all before the public launch: run
  `deploy/builds-teardown.sh`, then delete `server/builds.js` (and its two lines in `server/index.js`),
  `test/builds.test.js`, the "test build page" steps in `.github/workflows/android.yml`, the `/internal/**`
  rewrite in the website's `firebase.json`, the three GitHub variables, and both `deploy/builds-*.sh` scripts.
- Razorpay-only builds stay off the Play Store until Play Billing is in (`docs/PAYMENTS.md`).

## Pending (as of the handoff)

Needs Prajwal: Google Play account type (personal → 14-day closed test with 12 testers); lawyer review of the
privacy policy and terms; Sarvam rate limits; domain email (`prajwal@adamspeaks.in`) and the stray `_dmarc`
record at GoDaddy; what to improve on the result screen; the tutor's final name.
For Claude: release signing + Play bundle + store listing + data-safety form (after the Play account);
rewrite Sakhi's AI instructions with example turns (approved, not built); re-tune level-4 cut-offs with real
results; optionally move the project under the adamspeaks.in organization; load balancer only if needed later.

## Where things are in the code

`server/` (index.js routes, session.js conversation, tutor.js Sakhi's lines, learning/ the learning module, admin/ and `public/admin/` the console, llm/ AI providers, settings.js live settings, scoring.js levels with
`shared/scoring-config.json`, accounts.js/store.js customer data, live.js speech relay, recordings.js,
voicecache.js), `shared/` (question bank, phrases), `public/` (web client, team tools), `android/` (Kotlin app,
README inside), `deploy/` (scripts, README), `docs/` (design notes, this file).
