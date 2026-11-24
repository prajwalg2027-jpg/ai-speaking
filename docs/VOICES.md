# Sakhi's voice, and comparing voices

## The voice the app uses

Admin console › **Settings** › **Sakhi's voice** (settings section `voice`, `server/settings.js`; spoken by
`streamSpeech` in `server/sarvam.js`). It can be changed there without a deploy.

- **Default: Gemini 3.8 Flash-Lite TTS through Vertex AI**, voice **Sulafat** (warm), told to speak "warmly and
  naturally, like a kind, friendly Indian tutor, at an easy conversational pace" (not "patiently": Gemini voices
  hear that as "slowly"). Google calls Flash-Lite its fast model; it is also the cheapest
  (about ₹0.80 a minute, doubling on 1 Jan 2027). It signs in as the server's Cloud Run account (which already has
  Vertex AI access for Gemini as the AI), so it is **billed to the Google Cloud project** and credits pay for it.
  No key. Vertex AI's price for these models is taken to be Google's Gemini API price.
- Also: 3.8 Flash TTS (best quality) through Vertex AI; the older Gemini models through Google Cloud
  Text-to-Speech (also billed to the project); or Sarvam Bulbul (`SARVAM_TTS_MODEL`, `SARVAM_TTS_SPEAKER`).
  The Gemini API with a key is used only if the server is switched off Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=false`).
- **Sarvam stays the safety net**: if the Google voice fails before any sound, Sarvam says that line (and it is not
  kept, so Google is tried again next time). Where Google can't be reached at all (a laptop without Google sign-in,
  not on Vertex AI), Sarvam speaks.
- **Speed** (`voice.speed`, default 1.15; 1 is Google's own speed): sent to Cloud Text-to-Speech as its speaking
  rate. Vertex AI takes no number, so above 1.1 it is told "speak at a brisk, natural pace" in words. A question
  said again (`pace` 0.9 or less) is 10% slower; the 0.95 lines (Hindi, follow-up questions) are Sarvam's tuning
  and Google says them at the normal speed (`googlePace` in `server/sarvam.js`). Changing it makes the fixed lines
  again. Try a speed first on Compare voices (Google Cloud, Pace).
- **One voice request per turn** (on by default, Google voices only): a turn's lines are joined into one line
  before the app gets the turn (`server/voicejoin.js`), so each turn is one request to Google. The free trial
  allows 10 Gemini voice requests a minute for the whole project, so this fits about three times as many turns.
  The cost: her first sound waits for the whole turn, and her reaction is no longer said before the rest of the
  turn is written. Fixed lines and lines at another pace stay apart. Off in the settings: one request per line.
- Fixed lines are kept per voice, so after a change they are made again once (about 124 lines) and stored.
- What Google charges is counted in each conversation's cost and the daily budget (by seconds of sound).
- The app reads the sample rate from the server (24 kHz for both), so no new app build is needed.

## Comparing voices

Admin console › **Compare voices** (`server/admin/voices.js`, `server/voices/index.js`). It plays Sakhi's words in
several voices side by side. Nothing on this page changes the app's voice. Three sources:

| | How it is called | Models | Sign-in | Streamed |
| --- | --- | --- | --- | --- |
| **Sarvam** | REST, streamed | Bulbul v4 Flash, v3 (the app uses v4 Flash, `roopa_hi_companion`) | Sarvam key | yes |
| **Google Cloud TTS** | Cloud Text-to-Speech, `StreamingSynthesize` (gRPC) | Gemini 2.5 Flash TTS, 2.5 Flash-Lite (preview), 3.1 Flash (preview), 2.5 Pro | the server's Google Cloud service account (no key); billed to the project | yes: the sound comes back in pieces as it is made, once the text is in |
| **Google Gemini API** | Interactions API, `stream: true` | Gemini 3.8 Flash TTS, 3.8 Flash-Lite TTS, and the previews | a Gemini API key | Google's guide says so; not yet checked against Google |

Google's Cloud TTS guide says the newest models (3.8 Flash and Flash-Lite TTS) are **not** available through
Cloud Text-to-Speech, only through Vertex AI and the Gemini API; that is why both Google routes are on the page.
Each card shows **First sound after**, so the two routes can be measured on the same words.

## What it shows, for each voice

- the sound, to play or download, and a button to play every voice one after another (a blind A/B is easier
  that way);
- how soon the first sound arrived, and how long the whole clip took to make;
- the length of the speech, and how many characters a second it speaks;
- what the clip cost, per minute of speech, and what a whole talk and a number of talks would cost at that rate
  (type how many characters Sakhi says in a talk; her fixed lines are made once and reused, so only what the AI
  writes counts);
- for Google, the tokens it reported (or an estimate from the length of the sound when it did not).

**How it is sent** can be changed, to hear the seam you noticed between sentences:
- *As Sakhi is sent today*: her reaction and her question apart (marked with `|` in the text), English and Hindi
  apart;
- *As one request*: the whole text together;
- *One request per sentence*.

Pieces sent apart are joined with a short gap, as the app plays separate lines.

## The choices

- **Sarvam**: Bulbul v4 Flash (224 voices) and v3 (37), the names Sarvam's API accepts (asked on 23 Nov 2026,
  `server/voices/sarvam-voices.json`). A name is person_language_style: `roopa_hi_companion` is Roopa, Hindi,
  companion style. Controls: pace, pitch and steadiness (Sarvam's "temperature": lower is steadier).
- **Google**: Gemini 3.8 Flash TTS, 3.8 Flash-Lite TTS, and the older previews. Its 30 studio voices (Kore,
  Sulafat, Achird, …), and its wider voice library for English and Hindi when the server has the key. Google is
  told how to speak in words, the **style** ("warm, friendly and patient"), not with numbers. Sent through its
  Interactions API, streamed, as 24 kHz 16-bit sound (the same as the app plays).

## Prices (23 Nov 2026)

| | Billed by | Price |
| --- | --- | --- |
| Sarvam Bulbul v4 Flash | characters | ₹2 per 1,000 (pay as you go) |
| Sarvam Bulbul v3 | characters | ₹3 per 1,000 |
| Gemini 3.8 Flash TTS | seconds of sound (25 tokens a second) + text | $9 per million sound tokens, $0.50 per million text tokens: about ₹1.19 a minute. Doubles on 1 Jan 2027. |
| Gemini 3.8 Flash-Lite TTS | the same | $6 / $0.50: about ₹0.80 a minute. Doubles on 1 Jan 2027. |
| Gemini 3.1 Flash TTS (preview), 2.5 Pro TTS (preview) | the same | $20 / $1 |
| Gemini 2.5 Flash TTS (preview) | the same | $10 / $0.50 |
| Cloud TTS: Gemini 2.5 Flash TTS, 2.5 Flash-Lite (preview) | the same | $10 / $0.50: about ₹1.32 a minute |
| Cloud TTS: Gemini 3.1 Flash TTS (preview), 2.5 Pro TTS | the same | $20 / $1 |

The page's table puts them side by side assuming Sakhi speaks about 20 characters a second (what Sarvam's voice
measured); each card uses what its own clip really took. $1 = ₹88 unless `USD_INR` is set. What this page spends
on Google is not counted in the daily budget; Sarvam's is, and so is the app's own voice, whichever it is.

## To try Google's voices

**Google Cloud TTS** needs the Cloud Text-to-Speech API turned on in the project (the deploy setup does it from
now on; for the project as it is, once):

```bash
gcloud services enable texttospeech.googleapis.com --project=cool-arch-515210-b0
```

It signs in as the Cloud Run service account, so it works only on the deployed server, not on a local one. If
Google refuses it, its own words show on the card.

**The Gemini API** needs the Gemini key (the same one Gemini as the AI uses):

```bash
PROJECT=cool-arch-515210-b0 PROVIDERS=gemini ./deploy/llm-keys-setup.sh
```

Then deploy the server. Without the key, Google's voices fail on the page with a message saying so.

## Not done yet

The app still speaks with Sarvam. Moving Sakhi's live voice to Google would mean choosing the voice provider in
Settings, the voice cache keyed on it, and checking how soon Google's first sound arrives from India in a real
call; decide that after comparing here.
