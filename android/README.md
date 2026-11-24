# Adam for Android

Native Kotlin + Jetpack Compose client for Adam, the English speaking coach (its tutor is Sakhi). The Node server in this
repository stays the backend: it holds the Sarvam key and the conversation logic, so the key never ships
in the app. The app only talks and listens.

## Run it on your phone

1. Start the server on your Mac: `npm start` (port 3000).
2. Install the debug app (`in.adamspeaks.app.dev`, installs next to a release build):
   - from CI: download `sakhi-debug-apk` from the latest "Android" GitHub Actions run, or
   - build it: `cd android && ./gradlew :app:installDebug` (JDK 21 and the Android SDK, or open `android/` in Android Studio).
3. Point it at your Mac: long-press the "Adam" logo and enter `http://<your Mac's Wi-Fi address>:3000`
   (System Settings › Wi-Fi › Details). Phone and Mac must be on the same Wi-Fi. To bake the address into
   the build instead, add `sakhi.serverUrl=http://192.168.1.20:3000` to `android/local.properties`.

The release build talks only HTTPS, to `SAKHI_SERVER_URL` (Gradle property `sakhi.releaseServerUrl`), and
can't be pointed elsewhere.

## Phone login

The app opens on phone OTP sign-in, then asks the person to confirm they're 18 or older and agree to the terms,
the privacy policy and keeping voice recordings. Only then does the conversation start. The code is sent by SMS
through the Adam server, which uses MSG91 (`server/login.js`): nothing about the SMS provider is in the app. The
server returns a session token (60 days, refreshed when under a week is left) that goes on every request and on
the live speech connection. The account button (top right) has *Sign out* and *Delete my account and data*
(Google Play requires in-app deletion). The test number set on the server signs in with its fixed code.

## How it works

| Part | File | Notes |
|---|---|---|
| Conversation loop | `conversation/ConversationViewModel.kt` | Port of `public/app.js` `run()`: speak each line (words revealed with the voice), listen for one answer, send the turn, now and then a soft "Mm-hmm." while waiting. |
| Answer rules | `conversation/AnswerCollector.kt` | Port of `public/live.js` `listen()`: grace period, multi-utterance answers, nudge at 6 s, give up at 12 s, 45 s cap. Pure, unit-tested. |
| Microphone | `audio/MicCapture.kt` | 16 kHz PCM16 via the voice-communication source: the phone's echo canceller removes Sakhi's voice. |
| Interruptions | `audio/BargeInDetector.kt`, `audio/VoicePlayer.kt` | Sakhi dips the moment the learner speaks and stops after 300 ms of speech. |
| No lost words | `audio/AudioGate.kt`, `audio/PcmRing.kt` | Mic audio is kept for 10 s while not listening (not billed) and sent from where the learner started talking. |
| Speaker routing | `audio/AudioRouting.kt` | Communication mode + loudspeaker (headset if connected); audio focus ends the conversation on a phone call. |
| Server API | `net/SakhiApi.kt`, `net/LiveConnection.kt`, `net/Models.kt` | Same endpoints as the web app; `/api/live` WebSocket for speech-to-text. |
| Sign-in | `auth/AuthViewModel.kt`, `auth/OtpPhoneAuth.kt`, `auth/AuthHttp.kt`, `ui/LoginScreens.kt` | Phone → code → consents; the session token is added to every request and refreshed before it expires (or after a 401). |
| Learning | `learn/LearnViewModel.kt`, `learn/LearnVoice.kt`, `net/LearnApi.kt`, `ui/LearnScreens.kt` | After the score and a subscription: practice with Sakhi (type, or tap the mic and speak; her reply first, then the correction card), lessons with exercises, progress. A subscribed learner with a level opens straight into it. |
| Screen | `ui/SakhiScreen.kt`, `ui/Orb.kt`, `ui/theme/Theme.kt` | The design handoff: Molten orb, conversation, fanned card, hint, result, mic screen. Light and dark. |

Leaving the app ends the conversation (a voice conversation can't go on unseen, and Android limits background microphone use).

## Checks

- `./gradlew :app:testDebugUnitTest`: unit tests for all the logic, the server's real JSON (fixtures in
  `app/src/test/resources`), the HTTP API, and screen renders saved to `app/build/screenshots` (Robolectric, no emulator).
- End to end against a running server: `SAKHI_E2E_URL=http://127.0.0.1:3000 ./gradlew :app:testDebugUnitTest --tests '*ServerEndToEndTest*'`
- `./gradlew :app:lintDebug`
- CI (`.github/workflows/android.yml`) runs all of these on every push and uploads the debug APK. With the
  signing secrets set it also builds the signed release bundle (`.aab`) for Google Play.

## Release signing (CI secrets)

`SAKHI_KEYSTORE_B64` (base64 of the upload keystore), `SAKHI_KEYSTORE_PASSWORD`, `SAKHI_KEY_ALIAS`,
`SAKHI_KEY_PASSWORD`, and the repository variable `SAKHI_SERVER_URL`. Keep the keystore out of the repository.

## Sakhi's turn, in parts

The app asks the server for each turn in parts (`SakhiApi.turn`, `Accept: application/x-ndjson`). When the server
can, it sends Sakhi's reaction before the rest of her turn is written; the app says it at once
(`ConversationViewModel.run`) and carries on with the rest when the whole turn arrives. A server that answers in
one piece works too. See `docs/PLACEMENT.md` › Streaming.

