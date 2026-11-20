// The shapes the tutor's AI must return, checked on every reply (Zod is Node's equivalent of Pydantic).
// Field names are snake_case because that's what the model writes; the runtime converts them for the app.
// Optional values are `nullable` (not missing) so the same schemas work as strict structured outputs.
import { z } from 'zod';

export const CATEGORIES = ['grammar', 'vocabulary', 'spelling', 'word_order', 'naturalness'];
export const SEVERITIES = ['minor', 'moderate', 'important'];

/**
 * Concepts a correction or a correct use can be filed under, so mistakes can be tracked over time. Short and
 * stable on purpose: progress is counted per concept.
 */
export const CONCEPTS = [
  'past_simple', 'past_irregular', 'present_simple', 'third_person_s', 'present_continuous', 'present_perfect',
  'future', 'articles', 'prepositions', 'plurals', 'pronouns', 'subject_verb_agreement', 'questions', 'negatives',
  'word_order', 'modal_verbs', 'comparatives', 'conjunctions', 'word_choice', 'collocation', 'spelling', 'other',
];

const text = (max) => z.string().trim().min(1).max(max);

export const Correction = z.strictObject({
  original: text(200),          // the learner's exact words that are wrong
  corrected: text(200),         // the better words, replacing exactly `original`
  category: z.enum(CATEGORIES),
  concept: z.enum(CONCEPTS),
  explanation: text(400),       // simple words, at the learner's level
  severity: z.enum(SEVERITIES),
});

export const LearningSignal = z.strictObject({
  kind: z.enum(['correct_use']),
  concept: z.enum(CONCEPTS),
  evidence: text(200),          // the learner's words that show it
});

/** One tutor turn: the natural reply, and corrections shown separately. */
export const TutorOutput = z.strictObject({
  reply: text(1200),
  corrections: z.array(Correction).max(10),
  encouragement: z.string().trim().max(200).nullable(),
  follow_up_question: z.string().trim().max(300).nullable(),
  learning_signals: z.array(LearningSignal).max(5),
});

/** The check (strategy B): keep or drop each proposed correction. */
export const VerifyOutput = z.strictObject({
  decisions: z.array(z.strictObject({
    index: z.number().int().min(0),
    keep: z.boolean(),
    reason: z.string().trim().max(300),
  })).max(10),
});

/** A lesson exercise, judged. */
export const ExerciseEvaluation = z.strictObject({
  verdict: z.enum(['correct', 'partly', 'incorrect']),
  feedback: text(600),
  corrections: z.array(Correction).max(5),
});

/** A lesson's teaching turn (explaining the concept with examples). */
export const LessonTeaching = z.strictObject({
  explanation: text(1500),
  examples: z.array(text(300)).min(1).max(5),
  check_question: z.string().trim().max(300).nullable(),
});
