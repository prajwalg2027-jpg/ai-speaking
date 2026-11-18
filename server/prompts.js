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

export const INTENT_SYSTEM = `A learner was asked a question by a voice tutor. Classify their reply.
Labels: answer (they attempted to answer), repeat (want it repeated / didn't understand), slower, in_hindi (want Hindi),
dont_know, off_topic. Reply with ONLY JSON: {"intent":"<label>"}`;
