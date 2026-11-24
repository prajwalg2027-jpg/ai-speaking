# Adam: a voice-first English coach

Adam (`adamspeaks.in`) is an Android app for Indian learners: a spoken placement test and a tutor called **Sakhi**
who practises English with you. This one repository holds everything: the server, the Android app and the website.

**Start with [docs/HANDOFF.md](docs/HANDOFF.md)**: what runs where, how each piece is released, and what's pending.
Work happens on the branch `tutor-conversation` (the default branch).

## What's where

| Folder | What it is | How it's released |
|---|---|---|
| `server/`, `shared/`, `test/`, `package.json`, `Dockerfile` | The Node server on Google Cloud Run (Mumbai): conversation, placement, learning, payments, admin API | Cloud Build, `deploy/cloudbuild.yaml` (HANDOFF.md) |
| `android/` | The Kotlin Android app ([android/README.md](android/README.md)) | GitHub Actions builds and tests it; Play bundle via `android/release.sh` |
| `website/` | adamspeaks.in: landing page, privacy, terms, delete-account, `app-config.json` ([website/README.md](website/README.md)) | Firebase Hosting, by hand |
| `public/admin/` | The admin console at adamspeaks.in/admin | With the server |
| `public/` (other files) | Team tools for your own computer: STT lab, mic test, question review, cut-off editor. Off in production | `npm start` locally |
| `deploy/` | Setup scripts for Google Cloud, login, payments, AI keys ([deploy/README.md](deploy/README.md)) | Run by hand |
| `docs/` | Design notes and evaluations | |
| `scripts/` | Claude Code's sync and auto-save hooks, the corrections evaluation | |

## Run the server on your computer
```bash
npm install
cp .env.example .env     # add SARVAM_API_KEY (required)
npm start                # http://localhost:3000 (team tools: /stt-lab.html, /mic-test.html)
npm test                 # database tests need TEST_DATABASE_URL
```
Node ≥ 20. The server's own address has no learner page; `/` sends visitors to adamspeaks.in.

## Design docs
- [docs/PLACEMENT.md](docs/PLACEMENT.md): the placement test (classic and conversation).
- [docs/LEARNING.md](docs/LEARNING.md): the learning module and admin console.
- [docs/03-conversation.md](docs/03-conversation.md), [docs/01-assessment-design.md](docs/01-assessment-design.md),
  [docs/02-sarvam-integration.md](docs/02-sarvam-integration.md): how the conversation, the scoring and Sarvam fit together.
- [docs/VOICES.md](docs/VOICES.md), [docs/LOGIN.md](docs/LOGIN.md), [docs/PAYMENTS.md](docs/PAYMENTS.md).
