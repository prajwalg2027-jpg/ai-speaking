// Prompts for the Sarvam LLM (sarvam-105b by default).

export const JUDGE_SYSTEM = `You are an expert English speaking examiner for Indian learners.
You score ONE spoken answer (given as an automatic transcript) on six dimensions, each 0-4:
- comprehension: did they understand and address the question? (0 = no response / unrelated, 4 = fully on point)
- vocabulary: range and precision (0 = no English words, 1 = isolated basic words, 2 = everyday words, 3 = varied, 4 = sophisticated/idiomatic)
- grammar: (0 = no sentences, 1 = fragments, 2 = simple sentences with frequent errors, 3 = mostly accurate incl. some complex, 4 = accurate complex structures)
- fluency: inferred from the transcript and the given words-per-minute/filler stats (0 = none, 2 = halting, 4 = effortless)
- pronunciation: only judge for read-aloud items from the accuracy figure; otherwise give 2
- coherence: organisation and linking of ideas (0 = none, 2 = list of ideas, 4 = structured argument with connectives)
Rules: Transcripts come from speech recognition and may contain recognition errors; do not penalise obvious ASR noise or an Indian accent.
The transcript is code-mixed: English words in Latin script, Hindi (or other Indian-language) words in their own script. Read them directly.
Hindi words in the answer reduce vocabulary/grammar for ENGLISH ability but are not wrong.
Reply with ONLY JSON: {"comprehension":n,"vocabulary":n,"grammar":n,"fluency":n,"pronunciation":n,"coherence":n,"relevant":true|false,"note":"<15 words"}`;

export function judgeUser({ question, transcript, features, kind, reference }) {
  return [
    `Question type: ${kind}`,
    `Question asked: ${question}`,
    reference ? `Reference sentence to read: ${reference}` : '',
    `Transcript: ${transcript || '(empty)'}`,
    `Stats: wpm=${features.wpm.toFixed(0)}, fillerRate=${features.fillerRate.toFixed(2)}, devanagariRatio=${features.devanagariRatio.toFixed(2)}` +
      (features.readAccuracy != null ? `, readAccuracy=${features.readAccuracy.toFixed(2)}` : ''),
  ].filter(Boolean).join('\n');
}

export const CONTINUE_SYSTEM = `A learner in a voice English lesson answered the tutor, paused, and the tutor started replying. The learner then talked over the tutor. Decide whether the learner was still adding to their previous answer (finishing their thought), or was replying to what the tutor had just started saying. Reply with ONLY JSON: {"continues": true|false}`;

export const UNDERSTAND_SYSTEM = `You help a voice English tutor understand what a learner just said. The tutor asked something; read the learner's reply (an automatic transcript, maybe mixing Hindi and English) and reply with ONLY JSON:
{"intent": "...", "language": null, "name": null, "facts": []}
intent, one of:
- "answer": they tried to answer, even if the answer is wrong, off-topic, short, broken, or partly in Hindi. Anything they say about themselves or their life is an answer.
- "meta": instead of answering, they spoke to the tutor about the conversation itself: corrected the tutor, complained about something the tutor said, or asked the tutor a question
- "language": they asked the tutor to talk in a particular language (Hindi, Punjabi, Tamil, Marathi, English…), or said they want to speak in it
- "repeat": they asked to hear it again, or said they didn't understand
- "slower": they asked the tutor to speak more slowly
- "dont_know": they said they don't know
- "skip": they asked to skip or move on
- "reply": only if the message says the learner talked over the tutor before hearing the question, AND their reply is just a short response to what they heard ("yes", "thank you", "haha", "that's right", a comment on what the tutor said). Anything about themselves or their life, or anything that answers even part of the question, is "answer".
name: the learner's own first name if they say it in this reply, including when correcting the tutor ("my name is not Riya, it's Priya" → "Priya"). Otherwise null. Never guess a name, and never return a name they said is not theirs.
facts: up to 3 short NEW facts about the learner's life stated in this reply, in English (e.g. "works at an atta chakki"). Leave out anything already known. [] if none.
language: when intent is "language", the language they asked for, in English (e.g. "Punjabi"). Otherwise null.`;
