# Comparing voices

Admin console › **Compare voices** (`server/admin/voices.js`, `server/voices/index.js`). It plays Sakhi's words in
several voices side by side, from **Sarvam** (Bulbul, what the app uses today: `roopa_hi_companion`) and **Google
Gemini** (its text-to-speech models). Nothing on this page changes the app's voice.

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

The page's table puts them side by side assuming Sakhi speaks about 20 characters a second (what Sarvam's voice
measured); each card uses what its own clip really took. $1 = ₹88 unless `USD_INR` is set. Google's spending is
not counted in the daily budget; Sarvam's is.

## To try Google's voices

The server needs the Gemini key (the same one Gemini as the AI uses):

```bash
PROJECT=cool-arch-515210-b0 PROVIDERS=gemini ./deploy/llm-keys-setup.sh
```

Then deploy the server. Without the key, Google's voices fail on the page with a message saying so.

## Not done yet

The app still speaks with Sarvam. Moving Sakhi's live voice to Google would mean choosing the voice provider in
Settings, the voice cache keyed on it, and checking how soon Google's first sound arrives from India in a real
call; decide that after comparing here.
