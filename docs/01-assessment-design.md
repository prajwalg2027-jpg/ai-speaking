# Voice-only English placement: design

> Written 16 Nov 2026, before the test was built. The **four levels** and **what we measure from voice** (sections
> 1 and the level table) still hold and the classic test's scoring is built on them. The question list below is the
> original 4-question plan: the classic test now has five parts (`shared/assessment.js`, `docs/03-conversation.md`),
> and the conversation test is in `docs/PLACEMENT.md`.

The goal is to place a new user into one of **four levels** in about 3–4 minutes, using
voice only (plus something on screen to look at), without making a beginner feel tested
or bored, and without letting a fluent speaker coast through questions that are too easy.

| Level | Name | Who this is | Rough CEFR |
|---|---|---|---|
| **L1** | Starter | Little or no English. Understands Hindi (or another Indian language) prompts, may know a handful of words ("hello", "water", "phone"). | Pre-A1 |
| **L2** | Word-builder | Knows plenty of words and set phrases, but builds sentences slowly, with Hindi fill-ins, missing verbs or tenses, long pauses. | A1–A2 |
| **L3** | Conversational | Holds a conversation comfortably. Some grammar slips and a plain vocabulary, but gets the meaning across without much effort. | B1–B2 |
| **L4** | Eloquent | Precise, varied, idiomatic. Uses subordinate clauses, hedging, abstract and less common vocabulary, and builds a structured argument. | C1–C2 |

---

## 1. What we can measure from voice alone

You can't assess speaking ability with a single question. Each answer gives us several
**signals**. Some come from audio and timing and are computed deterministically. Others
need language understanding and come from the LLM.

| Signal | How we get it | What it tells us |
|---|---|---|
| **Response language** | The STT language ID (`language_code`) plus the share of Devanagari characters in the transcript | Did they choose, or need, to answer in Hindi? This is the strongest L1 signal. |
| **Comprehension** | Did the answer actually respond to the question? (LLM relevance check) | Understanding a spoken English prompt is a skill in its own right, separate from speaking. |
| **Fluency** | Words per minute over speech time, the share of the turn spent in pauses, filler rate (`um`, `uh`, `matlab`, `like`) | L2 is slow and halting, L3+ is smooth. |
| **Pronunciation / intelligibility** | Read-aloud word accuracy: the STT transcript compared with the reference sentence by word-level edit distance | Can a machine (a proxy for a listener) understand them? We **don't** penalise an Indian accent. Saaras v4 is trained on Indian English, so accented but clear speech still transcribes well. |
| **Vocabulary range** | Unique words, average word length, share of words outside the top-2k frequency list, judged by the LLM | Separates L3 from L4. |
| **Grammar** | LLM rubric: verb agreement, tense, articles, sentence completeness | Separates L2 from L3. |
| **Discourse / coherence** | LLM rubric: connectives (*however, which means, on the other hand*), a stated position with reasons, staying on topic | Separates L3 from L4. |
| **Code-mixing** | The share of Hindi words inside an English answer | Heavy mixing points to L2, occasional mixing is normal at L3. |

---

## 2. The four questions (adaptive)

The flow is a **staircase**. Q1 sets a provisional level, and Q2–Q4 each come in
variants for that level, so everyone gets questions close to their edge. Every prompt is
spoken in English first. If the user says they didn't understand (or stays silent), the
bot repeats it slowly and then asks it in Hindi. *Needing* the Hindi version is itself
recorded as a comprehension signal.

### Q1 · Open warm-up (the router)
> 🔊 *"Hi! I'm Sakhi, your English buddy. Tell me a little about yourself: your name, and what you do during the day. You can speak in English or Hindi, whatever feels comfortable."*

- **Why it works:** it is non-threatening and open-ended, and it explicitly allows Hindi.
  Whether they *choose* English is the cleanest first cut.
- **Routing:**
  - Answer mostly in Hindi, or no English sentence → provisional **L1**
  - English words, but fragments, pauses, or code-mixing → provisional **L2**
  - Complete English sentences at a steady pace → provisional **L3**
  - Long, varied answer with complex structures → provisional **L4** (confirmed later)

### Q2 · Vocabulary bridge ("what is this called?")
A picture or word on screen, in both directions between Hindi and English.

| Provisional | Prompt | Expected |
|---|---|---|
| L1 | 🖼️ Picture of an apple: *"What is this called in English?"* then *"'Paani' ko English mein kya kehte hain?"* | apple, water |
| L2 | 🖼️ Picture of an umbrella: *"What is this called in English?"* then *"What is 'library' in Hindi?"* | umbrella, pustakalay / library |
| L3 | *"How would you say 'ज़िम्मेदारी' in English?"* then *"What does 'deadline' mean? Explain in one sentence."* | responsibility, plus a definition |
| L4 | *"Give me one English word for 'आत्मनिर्भर'. Then tell me the difference between 'persuade' and 'convince'."* | self-reliant / self-sufficient, plus a nuanced distinction |

- **Why it works:** it separates *knowing words* from *building sentences*. This is the L1
  vs. L2 boundary, which an open question can't measure because a beginner just goes
  quiet. The reverse direction (English → Hindi) checks that they understand a word, not
  just that they've memorised it.

### Q3 · Read aloud
A sentence appears on screen. *"Please read this sentence out loud."*

| Provisional | Sentence |
|---|---|
| L1 | "My name is Ravi. I like tea." |
| L2 | "Every morning I take the bus to work, and it is always crowded." |
| L3 | "Although the weather was terrible, we decided to continue our journey to the mountains." |
| L4 | "The committee's unprecedented decision was, paradoxically, both a vindication of its critics and an indictment of its own procedures." |

- **What we measure:** word accuracy against the reference (intelligibility), reading pace
  and hesitations. The answer is known in advance, so this is the most **objective**
  signal and isn't affected by what the person chooses to say.
- **Ceiling probe:** if someone reads their level's sentence with at least 95% accuracy
  and good pace, they get the next level's sentence as a bonus. This catches strong
  readers who were shy in Q1.

### Q4 · Spontaneous opinion (the ceiling test)
| Provisional | Prompt |
|---|---|
| L1 | *"Aapko kaunsa khana pasand hai? Try to say it in English: 'I like…'"* (scaffolded) |
| L2 | *"What did you do last weekend?"* (past tense, simple narration) |
| L3 | *"If you could change one thing about your city, what would it be and why?"* (conditional plus reasons) |
| L4 | *"Some people say smartphones have made us more connected but lonelier. What's your view?"* (abstract argument, hedging, nuance) |

- **Why it works:** only unplanned speech shows real range: grammar under pressure,
  connectives and argument structure. This is the L3 vs. L4 separator. The L1 prompt is
  scaffolded so a beginner leaves on a *success* ("I like dosa!") instead of in silence.

---

## 3. Scoring

Each answer is scored on six dimensions (0–4): **comprehension, vocabulary, grammar,
fluency, pronunciation, coherence**. Scores come from two places:

1. **Deterministic features** (`server/scoring.js`): Devanagari ratio, WPM, filler rate,
   read-aloud accuracy, lexical diversity. These are cheap and reproducible, and they
   still work if the LLM fails.
2. **LLM judge** (Sarvam-105B, `server/prompts.js`): a rubric prompt that returns strict
   JSON with a per-dimension score and a short reason.

The final level is computed **in code, not by the LLM**: a weighted blend of the
dimension averages (LLM 60%, features 40%), then fixed thresholds. Some rules override
the blend:

- If Q1 was in Hindi **and** Q2 missed the L1 words, the user can be no higher than **L1**.
- **L4** needs coherence ≥ 3.5 **and** vocabulary ≥ 3.5 in Q4. Fluent but plain speakers
  stay at L3.
- If Q3 read-aloud accuracy is below 60%, the user can be no higher than **L2**.

The user sees a friendly result ("You're a **Conversational** speaker 🎉, here's what
we'll work on"), never a raw score.

## 4. Experience principles
- **Never leave a beginner in silence.** After 6s of silence there's a nudge, and after
  12s the bot offers the Hindi version. It always moves on gracefully.
- **No right or wrong feedback during placement.** The bot gives warm acknowledgments
  only ("Nice!", "Got it, thank you").
- **Adapt the language of instructions, not the test item.** Instructions can switch to
  Hindi, but the item being assessed stays in English.
- **Short.** Four questions, at most two retries each, done in under 4 minutes.
