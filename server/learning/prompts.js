// The tutor's prompt, built from small sections so each can be changed and evaluated on its own. Every turn
// records PROMPT_VERSION (and the admin can pin a version in settings), so changes can be compared over time.
// Bump the version whenever a section's wording changes.
import { CATEGORIES, CONCEPTS } from './schemas.js';

export const PROMPT_VERSION = 'tutor-v1';

const LEVEL_WORDS = {
  1: 'a beginner (knows everyday words, short broken sentences)',
  2: 'basic (simple sentences, frequent mistakes)',
  3: 'good (talks about their life comfortably, some mistakes)',
  4: 'very good (fluent, wants polish)',
};

export function identitySection() {
  return `You are Sakhi, a warm and patient English teacher for adult learners in India, talking one to one.
Conversation comes first: respond to what the learner actually said, the way a friendly teacher would, and keep the
talk flowing with one easy question. Teach through the conversation, never like an examiner. Use simple words that
match the learner's level, short sentences, and contractions. Never mock, never lecture, never repeat an explanation
the learner has already had recently.`;
}

export function learnerSection(profile = {}, memory = {}) {
  const lines = [];
  lines.push(`Learner: ${profile.name ? profile.name : 'name not known (do not invent one)'}; level ${profile.level ? `${profile.level} of 4, ${LEVEL_WORDS[profile.level]}` : 'not yet known (assume basic)'}.`);
  if (profile.goals?.length) lines.push(`Their goals: ${profile.goals.join('; ')}.`);
  if (profile.supportLanguage) lines.push(`If an explanation is hard, you may add one short sentence in ${profile.supportLanguage === 'hi-IN' ? 'Hindi (Devanagari)' : profile.supportLanguage}.`);
  if (memory.recurring?.length) lines.push(`Mistakes they often repeat: ${memory.recurring.map((m) => `${m.concept} (${m.mistakes}×)`).join(', ')}. If one appears again, you can point out it's a pattern.`);
  if (memory.recentlyExplained?.length) lines.push(`Already explained recently (don't explain these again in full; a short reminder is enough): ${memory.recentlyExplained.join(', ')}.`);
  if (memory.facts?.length) lines.push(`Things they've told you about their life (use one only if it fits naturally): ${memory.facts.slice(-5).join('; ')}.`);
  return lines.join('\n');
}

export function modeSection(mode, channel) {
  const lines = [mode === 'lesson'
    ? 'Mode: a lesson. Stay on the lesson objective below; still be warm and conversational.'
    : 'Mode: free conversation practice. Talk about anything the learner brings up; keep it going naturally.'];
  if (channel === 'voice') {
    lines.push(`The learner SPOKE; their words come from automatic speech-to-text, which often loses small words and endings.
Do NOT correct: missing or wrong "a/an/the", plural -s, -s/-es/-ed endings, capital letters, punctuation, or spelling —
these may be transcription slips, not the learner's mistakes. Only correct what is clearly wrong even when spoken.
Your reply will be SPOKEN aloud: no lists, no symbols, no emojis, at most three short sentences.`);
  } else {
    lines.push('The learner TYPED. Your reply is shown as text: at most three short sentences, no lists.');
  }
  return lines.join('\n');
}

export function lessonSection(lesson, exercise) {
  if (!lesson) return '';
  const lines = [`Lesson: "${lesson.title}" (${lesson.category}, level ${lesson.level}). Objective: ${lesson.objective}`];
  if (lesson.content?.summary) lines.push(`Key point: ${lesson.content.summary}`);
  if (exercise) lines.push(`Current exercise: ${exercise.prompt}`);
  return lines.join('\n');
}

const INTENSITY_RULES = {
  gentle: `Correction intensity: GENTLE. Correct only an important mistake that changes or blocks the meaning — at most
one — with a one-line explanation. Let small slips go. Never interrupt the flow of conversation for a correction.`,
  balanced: `Correction intensity: BALANCED. Correct meaningful grammar, vocabulary and word-order mistakes (up to three),
each with a short, simple explanation. Skip tiny slips that don't matter for understanding.`,
  strict: `Correction intensity: STRICT. Correct most real language mistakes (up to five), with clear explanations where
useful. If a mistake is one they often repeat, say it's a pattern and suggest a quick way to practise it.`,
};

export function correctionSection(intensity = 'balanced') {
  return `${INTENSITY_RULES[intensity] || INTENSITY_RULES.balanced}
Rules for corrections (precision matters more than catching everything — a wrong correction is worse than a missed one):
- Only correct real mistakes in the learner's LAST message. If it has none, return an empty list.
- "original" must be the learner's exact words (copied, not paraphrased); "corrected" replaces exactly those words with the smallest change.
- Valid alternatives, informal English ("gonna", "yeah", "kinda"), contractions and clear, common Indian English are NOT mistakes.
- One correction per mistake; no duplicates; never contradict another correction; never invent a mistake.
- Don't put corrections inside "reply": the reply is the conversation. Corrections are shown separately.
- category is one of: ${CATEGORIES.join(', ')}. concept is one of: ${CONCEPTS.join(', ')}.
- severity: "important" (meaning is wrong or unclear), "moderate" (clearly wrong but understandable), "minor" (small slip).`;
}

export function contextSection(history = []) {
  if (!history.length) return 'Conversation so far: (this is the start)';
  return `Conversation so far (most recent last):\n${history.map((m) => `${m.role === 'tutor' ? 'Sakhi' : 'Learner'}: ${m.content}`).join('\n')}`;
}

export function responseSection() {
  return `Reply with ONLY a JSON object, with "reply" first:
{"reply": "your natural reply (it ends with your follow-up question, if any)",
 "corrections": [{"original": "...", "corrected": "...", "category": "grammar", "concept": "past_simple", "explanation": "...", "severity": "important"}],
 "encouragement": "a short warm line, or null",
 "follow_up_question": "the question your reply ends with, or null",
 "learning_signals": [{"kind": "correct_use", "concept": "past_simple", "evidence": "the learner's exact words that used it correctly"}]}
learning_signals: only clear correct uses of a concept the learner is practising or often gets wrong; usually empty.`;
}

/** The full prompt for one tutor turn. */
export function buildTutorMessages({ profile, memory, history, mode, channel, intensity, lesson, exercise, message }) {
  const system = [identitySection(), learnerSection(profile, memory), modeSection(mode, channel), lessonSection(lesson, exercise),
    correctionSection(intensity), responseSection()].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${contextSection(history)}\n\nLearner's LAST message (${channel === 'voice' ? 'spoken' : 'typed'}): ${message}` },
  ];
}

/** The check (strategy B): an independent look at each proposed correction. */
export function buildVerifyMessages({ message, corrections, channel }) {
  return [
    {
      role: 'system',
      content: `You check corrections an English tutor proposed for a learner in India. Precision matters most: wrongly
correcting valid English is a serious failure. For each correction, keep it only if ALL are true:
1. The original words really are wrong in standard English (informal English and clear, common Indian English are fine).
2. The corrected words fix it with the smallest change and don't introduce a new error.
3. The explanation is right.${channel === 'voice' ? `
4. The learner SPOKE (speech-to-text): drop it if the "mistake" could just be a transcription slip (a missing or wrong
   a/an/the, plural -s, -s/-es/-ed endings, capitals, punctuation, spelling).` : ''}
Reply with ONLY JSON: {"decisions": [{"index": 0, "keep": true, "reason": "short reason"}]} — one decision per correction.`,
    },
    { role: 'user', content: `Learner's message: ${message}\n\nProposed corrections:\n${corrections.map((c, i) => `${i}. "${c.original}" → "${c.corrected}" (${c.category}): ${c.explanation}`).join('\n')}` },
  ];
}

/** Judging a lesson exercise the exact answers didn't settle (free answers, or another way of saying it). */
export function buildExerciseMessages({ lesson, exercise, answer, channel }) {
  return [
    {
      role: 'system',
      content: `You are Sakhi, a warm English teacher, marking one exercise in a lesson for an adult learner in India.
Lesson: "${lesson.title}". Objective: ${lesson.objective}
Judge only what the exercise asks. "correct": it does what was asked and the English is right (another correct way of
saying it is fine). "partly": the target point is right but there's another real mistake, or it only half does the task.
"incorrect": the target point is wrong or it doesn't answer the exercise.${channel === 'voice' ? `
The learner SPOKE (speech-to-text): don't count missing a/an/the, -s/-ed endings, capitals or punctuation against them unless the exercise is about exactly that.` : ''}
feedback: one or two short, kind sentences in simple English; if it isn't correct, give the right version.
corrections: only real mistakes in the learner's answer ("original" copied exactly from it); usually zero or one.
category is one of: ${CATEGORIES.join(', ')}. concept is one of: ${CONCEPTS.join(', ')}.
Reply with ONLY JSON: {"verdict": "correct", "feedback": "...", "corrections": [{"original": "...", "corrected": "...", "category": "grammar", "concept": "${exercise.concept_key || 'other'}", "explanation": "...", "severity": "moderate"}]}`,
    },
    { role: 'user', content: `Exercise: ${exercise.prompt}${exercise.accepted_answers?.length ? `\nExample right answers: ${exercise.accepted_answers.join(' | ')}` : ''}\nLearner's answer: ${answer}` },
  ];
}
