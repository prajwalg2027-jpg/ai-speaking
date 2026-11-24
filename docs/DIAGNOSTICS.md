# Diagnostics: reading what happened on a team phone

When something goes wrong while the team uses the Android app (Sakhi didn't hear, the voice cut out, a turn took
ten seconds, sign-in failed), the app's own detailed log shows what happened, step by step, with timings. It is
sent to the server automatically, and anyone with the phone's **diagnostics code** can read it.

## Who sends logs

Only phones signed in with a **team number**: the owners in `ADMIN_PHONES`, active members of the admin team
(admin console › Team), and numbers in the optional `DIAG_PHONES` server setting (comma-separated). Everyone else's
events stay in memory on their phone and are thrown away. Nothing to switch on: sign in with a team number.

The server answers `GET /api/diag/status` → `{ enabled }`; the app asks after sign-in and every 10 minutes.

## Getting the code

In the app: **Account (top right) › Copy diagnostics link**. It copies
`https://<server>/api/diag/logs/<32-character code>`. The code is made once per installation and stays the same, so
it only needs sharing once (keep it in project memory). Reinstalling the app makes a new one.

## Reading a log

```
scripts/diag-logs.sh <code or link> 2h              # the last two hours, one line an event
scripts/diag-logs.sh <code> 1d <sessionId>          # one placement test (the session ids are listed at the top)
FORMAT=json scripts/diag-logs.sh <code> 30m         # the same as JSON
```

or open the link in a browser (`?since=2h&session=…&format=json&limit=…`; the default is the last day, 2,000
latest events, as text). Logs are kept **14 days**.

A text line: `time  +ms-since-previous  A|S [category] name sid=… key=value…`. `A` is the app, `S` the server.

| Category | What |
|---|---|
| `app` | start (device, Android and app version, a run id per start), foreground / background, **crash** (with the stack; saved and sent on the next start) |
| `auth` | each sign-in step (phone, code, consents, ready) and the error shown, never the number or the code |
| `conv` | the placement conversation: start, session, each answer (transcript, language, speech seconds, why listening ended), each turn (how long the server took, Sakhi's lines, card, done), result, stop, failures |
| `voice` | each line Sakhi says: time to the answer's headers, **time to first audio**, how it ended (finished, barge-in, tap), how much was heard |
| `listen`, `live` | the live speech-to-text connection: connect / ready (ms) / failed, configure, speech_start, speech_end, final (text, language), dropped, errors |
| `mic` | microphone opened (echo canceller, noise suppressor, gain control available), read errors, stop |
| `audio` | barge-in (the learner talked over Sakhi) |
| `net` | every HTTP request: method, path (no query, no body), status, ms to the headers, request id |
| `learn` | every error the learning area shows |
| `event` | the product events the app already sends (`assessment.opened`, `learn.message`, …) |
| `server` | for requests from that phone: each request (status, ms), each placement turn's trace (what the server heard, its checks, the models used and their timings) |

The request id (`rid`) is also in the server's Cloud Run log line for the request (`rid` field), for anything
deeper.

## Live, over adb

On a team phone (or any debug build) every event also goes to logcat with the tag `AdamDiag`:

```
adb logcat -s AdamDiag
```

## What is never logged

One-time codes, login tokens, phone numbers, audio. The server drops keys such as `otp`, `code`, `token`,
`phone`, `authorization` whatever sends them, and cuts long text. Transcripts of what was said **are** logged:
that is what makes the log useful. That's one reason it is for team phones only.

## Where it lives

- App: `android/app/src/main/java/com/sakhi/app/diag/` (`Diag` the log, `DiagUploader` the sender,
  `DiagInterceptor` the request lines). Add a line anywhere with `Diag.log("cat", "name", "key" to value)`.
- Server: `server/diag.js`, table `diag_batches` (migration 009).
