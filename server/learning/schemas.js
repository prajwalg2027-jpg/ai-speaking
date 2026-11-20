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

/** The check (strategy B): a verdict on each proposed correction. Only "real_mistake" is shown. */
export const VERDICTS = ['real_mistake', 'not_a_mistake', 'bad_fix'];
export const VerifyOutput = z.strictObject({
  decisions: z.array(z.strictObject({
    index: z.number().int().min(0),
    original: z.string().max(200),   // echoed, so a decision can be matched even if the numbering slips
    verdict: z.enum(VERDICTS),
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

// ---- repairing near-misses --------------------------------------------------------------------
// Models sometimes answer with a label outside the list ("preposition", "tense", "high") or leave out an empty
// list. One stray label shouldn't cost the learner their reply, so these map near-misses onto the lists before
// validation. Anything that still doesn't fit is dropped (a correction) or fails validation (the reply itself).

const CATEGORY_ALIASES = {
  tense: 'grammar', verb: 'grammar', verbs: 'grammar', article: 'grammar', articles: 'grammar', preposition: 'grammar',
  prepositions: 'grammar', agreement: 'grammar', pronoun: 'grammar', pronouns: 'grammar', plural: 'grammar', plurals: 'grammar', syntax: 'grammar',
  vocab: 'vocabulary', word_choice: 'vocabulary', collocation: 'vocabulary', usage: 'vocabulary', idiom: 'vocabulary', lexical: 'vocabulary',
  punctuation: 'spelling', capitalization: 'spelling', capitalisation: 'spelling',
  order: 'word_order', question: 'word_order', questions: 'word_order',
  style: 'naturalness', fluency: 'naturalness', register: 'naturalness', natural: 'naturalness',
};
const CONCEPT_ALIASES = {
  tense: 'past_simple', past: 'past_simple', past_tense: 'past_simple', simple_past: 'past_simple', irregular_verbs: 'past_irregular', irregular_past: 'past_irregular',
  present: 'present_simple', simple_present: 'present_simple', third_person: 'third_person_s', present_progressive: 'present_continuous',
  article: 'articles', preposition: 'prepositions', plural: 'plurals', pronoun: 'pronouns', agreement: 'subject_verb_agreement',
  question: 'questions', question_formation: 'questions', negation: 'negatives', negative: 'negatives', modals: 'modal_verbs', modal: 'modal_verbs',
  comparative: 'comparatives', conjunction: 'conjunctions', vocabulary: 'word_choice', word: 'word_choice', collocations: 'collocation',
  conditional: 'modal_verbs', conditionals: 'modal_verbs', gerund: 'other', gerunds: 'other', infinitive: 'other',
};
const SEVERITY_ALIASES = { high: 'important', major: 'important', critical: 'important', serious: 'important', medium: 'moderate', mid: 'moderate', low: 'minor', small: 'minor', trivial: 'minor' };
const key = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const oneOf = (v, allowed, aliases, fallback) => { const k = key(v); return allowed.includes(k) ? k : aliases[k] ?? fallback; };
const str = (v) => (typeof v === 'string' ? v : v == null ? null : String(v));

function repairCorrection(c) {
  if (!c || typeof c !== 'object' || !str(c.original)?.trim() || !str(c.corrected)?.trim()) return null;
  return {
    original: str(c.original).slice(0, 200), corrected: str(c.corrected).slice(0, 200),
    category: oneOf(c.category, CATEGORIES, CATEGORY_ALIASES, 'grammar'),
    concept: oneOf(c.concept, CONCEPTS, CONCEPT_ALIASES, 'other'),
    explanation: (str(c.explanation)?.trim() || 'This is the usual way to say it.').slice(0, 400),
    severity: oneOf(c.severity, SEVERITIES, SEVERITY_ALIASES, 'moderate'),
  };
}
const list = (v) => (Array.isArray(v) ? v : []);
const nullable = (v, max) => { const s = str(v)?.trim(); return s ? s.slice(0, max) : null; };

export function repairTutorOutput(j) {
  if (!j || typeof j !== 'object') return j;
  return {
    reply: j.reply,
    corrections: list(j.corrections).map(repairCorrection).filter(Boolean).slice(0, 10),
    encouragement: nullable(j.encouragement, 200),
    follow_up_question: nullable(j.follow_up_question, 300),
    learning_signals: list(j.learning_signals).filter((s) => s && str(s.evidence)?.trim())
      .map((s) => ({ kind: 'correct_use', concept: oneOf(s.concept, CONCEPTS, CONCEPT_ALIASES, null), evidence: str(s.evidence).slice(0, 200) }))
      .filter((s) => s.concept).slice(0, 5),
  };
}

const CHECK_ALIASES = { real: 'real_mistake', mistake: 'real_mistake', correct_correction: 'real_mistake', valid: 'real_mistake', keep: 'real_mistake', show: 'real_mistake',
  not_mistake: 'not_a_mistake', no_mistake: 'not_a_mistake', fine: 'not_a_mistake', acceptable: 'not_a_mistake', false_correction: 'not_a_mistake', drop: 'not_a_mistake',
  wrong_fix: 'bad_fix', incorrect_fix: 'bad_fix', bad_correction: 'bad_fix' };
export function repairVerifyOutput(j) {
  if (!j || typeof j !== 'object') return j;
  return {
    decisions: list(j.decisions).filter((d) => d && typeof d === 'object').map((d, i) => ({
      index: Number.isInteger(Number(d.index)) && Number(d.index) >= 0 ? Number(d.index) : i,
      original: (str(d.original) || '').slice(0, 200),
      // A misspelt key ("verict") still carries the verdict.
      verdict: oneOf(d.verdict ?? Object.entries(d).find(([k]) => /^ver/i.test(k))?.[1], VERDICTS, CHECK_ALIASES, d.keep === true || ['true', 'yes'].includes(key(d.keep)) ? 'real_mistake' : 'not_a_mistake'),
      reason: (str(d.reason) || '').slice(0, 300),
    })).slice(0, 10),
  };
}

const VERDICT_ALIASES = { right: 'correct', yes: 'correct', partial: 'partly', partially: 'partly', partially_correct: 'partly', mostly_correct: 'partly', wrong: 'incorrect', no: 'incorrect' };
export function repairExerciseEvaluation(j) {
  if (!j || typeof j !== 'object') return j;
  return { verdict: oneOf(j.verdict, ['correct', 'partly', 'incorrect'], VERDICT_ALIASES, j.verdict), feedback: j.feedback, corrections: list(j.corrections).map(repairCorrection).filter(Boolean).slice(0, 5) };
}
