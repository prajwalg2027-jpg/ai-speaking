# Deploying the Adam server (Google Cloud Run, Mumbai)

## One-time setup (about 15 minutes)

1. A Google Cloud project with billing turned on (console.cloud.google.com → New project). Note its **project ID**.
2. The gcloud CLI on your Mac: `brew install --cask google-cloud-sdk`, then `gcloud auth login`.
3. From the repository folder:

   ```bash
   PROJECT=your-project-id ./deploy/cloudrun.sh
   ```

   The first run turns on the Google services it needs, asks for the Sarvam API key (stored in Secret
   Manager, never in a file), creates a service account that can read only that key, builds the container
   with Cloud Build and deploys it to `asia-south1` (Mumbai). It ends by printing the server's address,
   e.g. `https://adam-abc123-el.a.run.app`, and checking its health.
4. Give that address to the Android release build: GitHub → Settings → Secrets and variables → Actions →
   Variables → `SAKHI_SERVER_URL`.

The first run also creates the PostgreSQL database (Cloud SQL, Mumbai; daily backups, point-in-time
recovery, deletion protection), a private bucket for voice recordings (Mumbai), and gives the server's own
account only the access it needs. Database tables are created and updated automatically when the server starts.

## Phone login (Firebase, one time, about 10 minutes)

Adam's phone OTP login uses Firebase Authentication in the **same Google Cloud project**:

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → choose your existing
   Google Cloud project (don't create a new one).
2. **Build › Authentication › Get started › Sign-in method › Phone** → Enable. (Only phone; leave the others off.)
3. **Project settings › Your apps › Add app › Android**: package name `in.adamspeaks.app` (and `in.adamspeaks.app.dev`
   for the test build), plus the app's SHA-256 signing fingerprints (`./gradlew signingReport` prints them; for
   the Play release, copy the "App signing key" fingerprint from Play Console). Download `google-services.json`
   and send it to the developer, or add it as the GitHub secret `GOOGLE_SERVICES_JSON`.
4. **Authentication › Settings › Phone numbers for testing**: add a test number and code (e.g. +91 99999 00000 /
   123456) so the team can sign in without real SMS.

Phone sign-in sends a real SMS per login; Firebase charges per SMS after a free allowance (check the current
India rate in the Firebase pricing page). The server only accepts phone sign-in tokens for this project.

## Deploying a new version

Run the same command again. Cloud Run switches over without downtime; conversations in progress on the
old instance can finish for up to 10 seconds, so deploy when few learners are on.

## What production mode does (server/guard.js)

| | Default | Change with |
|---|---|---|
| Team tools (question review, cut-off editor, STT lab, mic test, cost, scoring trace) | Off | `SAKHI_TEAM_TOOLS=1` (keep off in production; use `npm start` on your Mac) |
| New conversations per device address per hour | 30 | `SAKHI_SESSIONS_PER_IP_HOUR` |
| Turns per conversation | 80 | `SAKHI_TURNS_PER_SESSION` |
| Listening time per conversation | 20 min | `SAKHI_LISTEN_SEC_PER_SESSION` |
| Daily Sarvam spend cap (₹, all conversations) | 3000 | `SAKHI_DAILY_BUDGET_INR` (also a variable of the deploy script) |
| Sakhi's voice | Only lines she said in that conversation, or her fixed lines | — |
| Login | Required: phone OTP (Firebase) on every request and on the live speech connection | `SAKHI_ALLOW_NO_LOGIN=1` only for a closed test without accounts |
| Before a first test | Agreed to terms, privacy, 18 or older, and keeping voice recordings | — |

Change a setting without redeploying the code:
`gcloud run services update adam --region asia-south1 --update-env-vars SAKHI_DAILY_BUDGET_INR=5000`

## Customer data

Tables (server/db/migrations): `users` (with a flexible `attributes` field), `attribute_definitions`
(the allowed property names: add a row to add a property), `attribute_history`, `consents`, `assessments`,
`assessment_answers`, `recordings`, `level_history`, `events` (the transaction log), `erasures`.
Voice recordings are kept with no expiry. `DELETE /api/me` (a customer's erasure request under the DPDP Act)
removes their recordings, properties and account and blanks their transcripts; anonymised scores and the
erasure record stay.

To look at the data: Cloud SQL → adam-db → **Cloud SQL Studio** (SQL in the browser, signed in as `adam`; the
password is in Secret Manager › adam-database-url).

## Things to know

- **One instance.** Conversations live in the server's memory, so the service runs exactly one instance
  (always on, so there's no cold start). It handles dozens of simultaneous conversations. Before needing
  more, conversations move to a shared store (Memorystore for Redis) and the instance limit is raised.
- **Start-up.** Sakhi's ~124 fixed voice lines are generated once (about ₹15) and kept in a private bucket
  (`<project>-adam-voice`); later starts load them in seconds at no Sarvam cost. Changing the voice or a line
  regenerates just those. Lines the AI writes in a conversation are never stored.
- **Sarvam rate limits.** The server retries when Sarvam says it's busy, but the plan's limits must cover
  peak use. Confirm them with Sarvam before launch.
- **Logs:** Cloud Run → adam → Logs. **Costs:** the daily cap above, plus a Google Cloud budget alert
  (Billing → Budgets) for the hosting itself.
- **Rough hosting cost:** one always-on instance (1 vCPU, 1 GB) with request-based billing, a few
  thousand rupees a month. Sarvam usage is the main cost.
