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

## Phone login with MSG91 (one time, about 10 minutes)

Learners and admins sign in with an SMS code sent by **MSG91**. The server sends and checks the code (MSG91's key
never leaves it), then gives the app its own login session (`server/login.js`, `docs/LOGIN.md`).

1. In [MSG91](https://msg91.com): **OTP › Widget › Create**. Channel SMS, and turn **off** captcha and invisible OTP
   (they don't work when the server calls MSG91). Note its OTP length (ours: 4). Copy the **Widget ID**. For app
   store reviewers, add a number under **Demo Credentials** (ours: +91 90000 00001).
2. Indian SMS needs DLT: MSG91's widget uses its own approved OTP template; if it asks you for a DLT template or
   sender ID, follow its steps there.
3. Find your **authkey** (MSG91 › Authkey). Don't paste it anywhere except the prompt in step 4.
4. In Cloud Shell, from the `ai-speaking` folder (your own widget id and number; several admins: commas):

```bash
PROJECT=cool-arch-515210-b0 MSG91_WIDGET_ID=your-widget-id OTP_LENGTH=4 ADMIN_PHONES=+919812345678 DEMO_PHONES=+919000000001 ./deploy/msg91-setup.sh
```

It asks for the authkey (hidden as you type) and stores it in Secret Manager, makes a random session secret,
and gives both to the server with the widget id, the code length and the admin numbers. Demo numbers (MSG91's
Demo Credentials, whose code reviewers know) can never be admins. Instead of MSG91's demo you can have this server
handle a test number: `TEST_PHONE=+919999900000 TEST_CODE=<4–8 digits>`.

Limits (to protect the SMS budget): Indian mobile numbers only; 5 codes per number and 20 per address an hour;
3,000 codes a day in all (`OTP_PER_PHONE_PER_HOUR`, `OTP_PER_IP_PER_HOUR`, `OTP_PER_DAY` change them); 5 tries
per code; a code lasts 10 minutes and works once.

Truecaller one-tap sign-in (optional): see `docs/LOGIN.md` › Truecaller for the client ids, then add
`TRUECALLER_CLIENT_IDS=<release id>,<test id>` to the command above.

## Payments with Razorpay (one time, about 15 minutes)

The learning module is a monthly subscription (₹299, an admin setting), paid through Razorpay after the free score.
Start with Razorpay's **test** keys, then switch to live:

```
PROJECT=cool-arch-515210-b0 RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX ./deploy/razorpay-setup.sh
```

It asks for the key secret (hidden), checks it with Razorpay, stores it and a webhook secret in Secret Manager, and
prints the webhook to add in Razorpay. Then turn the paywall on in the admin console (Settings › Payments). All the
steps, going live, and what Google Play needs before the Play release: `docs/PAYMENTS.md`.

## Test build download page (pre-production only; remove before launch)

The latest debug APK for testers at `https://adamspeaks.in/internal/<random token>`, refreshed by every push to
`tutor-conversation` or `main` (GitHub Actions uploads it; the page isn't linked or indexed). One time:

```
PROJECT=cool-arch-515210-b0 ./deploy/builds-setup.sh
```

(the build already knows where to upload). Removing it: `deploy/builds-teardown.sh` and `docs/HANDOFF.md` ›
Before production.

## Other AI models (optional)

The conversation placement test can run on Claude, OpenAI or Gemini instead of Sarvam (`docs/PLACEMENT.md`).
Add the keys you have (each is typed at a hidden prompt and kept in Secret Manager):

```
PROJECT=cool-arch-515210-b0 PROVIDERS=anthropic,gemini ./deploy/llm-keys-setup.sh
```

Then compare models in the admin console (Compare models) and choose one in Settings › Placement test.

## Admin console

At **https://adamspeaks.in/admin** (the website forwards `/admin` and the admin and sign-in APIs to the server;
`<server address>/admin/` works too): dashboard, live settings, playground, evaluations, conversations and lessons
(`docs/LEARNING.md`). Sign-in is the same SMS code. The numbers in `ADMIN_PHONES` (set by `msg91-setup.sh`) are
always **owners**; owners add everyone else on the console's **Team** page, each with a role (Owner, Admin, Analyst,
Support, or your own) that decides what they can see and change. See `docs/LEARNING.md` › Team and roles.

*Before MSG91:* phone login used Firebase (`deploy/firebase-setup.sh`, `deploy/admin-setup.sh`). The server
still accepts Firebase logins from older app builds while people update; new builds use MSG91 only.

## Deploying a new version

Run the same command again. Cloud Run switches over without downtime; conversations in progress on the
old instance can finish for up to 10 seconds, so deploy when few learners are on.

## What production mode does (server/guard.js)

| | Default | Change with |
|---|---|---|
| Team tools (cut-off editor, STT lab, mic test, cost, scoring trace) | Off | `SAKHI_TEAM_TOOLS=1` (keep off in production; use `npm start` on your Mac) |
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
