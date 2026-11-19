# Deploying the Sakhi server (Google Cloud Run, Mumbai)

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
   e.g. `https://sakhi-abc123-el.a.run.app`, and checking its health.
4. Give that address to the Android release build: GitHub → Settings → Secrets and variables → Actions →
   Variables → `SAKHI_SERVER_URL`.

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

Change a setting without redeploying the code:
`gcloud run services update sakhi --region asia-south1 --update-env-vars SAKHI_DAILY_BUDGET_INR=5000`

## Things to know

- **One instance.** Conversations live in the server's memory, so the service runs exactly one instance
  (always on, so there's no cold start). It handles dozens of simultaneous conversations. Before needing
  more, conversations move to a shared store (Memorystore for Redis) and the instance limit is raised.
- **Start-up cost.** Each new instance generates Sakhi's ~124 fixed voice lines (about ₹15, ~3 minutes, one
  at a time). Lines not ready yet are generated when first needed.
- **Sarvam rate limits.** The server retries when Sarvam says it's busy, but the plan's limits must cover
  peak use. Confirm them with Sarvam before launch.
- **Logs:** Cloud Run → sakhi → Logs. **Costs:** the daily cap above, plus a Google Cloud budget alert
  (Billing → Budgets) for the hosting itself.
- **Rough hosting cost:** one always-on instance (1 vCPU, 1 GB) with request-based billing, a few
  thousand rupees a month. Sarvam usage is the main cost.
