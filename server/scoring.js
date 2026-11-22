// Deterministic speaking features + final level computation.
// The LLM judge is one input; the level decision itself is made here, in code.

import { readFileSync } from 'node:fs';
import { normalizeForCompare } from './normalize.js';

// Every number that decides the level lives in shared/scoring-config.json (edited at /cutoffs.html).
export const CONFIG = JSON.parse(readFileSync(new URL('../shared/scoring-config.json', import.meta.url), 'utf8'));
// The values in use: the file's, until the admin console changes them (server/settings.js).
let C = CONFIG;
export function setScoringConfig(c) { C = c; }
export const scoringConfig = () => C;

const FILLERS = /\b(um+|uh+|erm|hmm+|like|matlab|basically|you know|wo|woh|toh)\b/gi;
const DEVANAGARI = /[ऀ-ॿ]/g;
const INDIC = /[\u0900-\u0D7F]/g; // every Indian script (Devanagari to Malayalam)
const COMPLEX_MARKERS = /\b(although|however|whereas|nevertheless|moreover|therefore|consequently|on the other hand|in contrast|which means|arguably|paradoxically|i would argue|to some extent|it depends|not only)\b/gi;

// \p{M} keeps Devanagari vowel signs inside words.
export const words = (t) => (t || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}'\s-]/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * Word-level edit distance accuracy (0..1) between reference and hypothesis. Both are normalised first
 * (numbers, currency, contractions, spelling), so "₹250" matches "two hundred and fifty rupees".
 */
export function readAccuracy(reference, hypothesis) {
  const r = normalizeForCompare(reference), h = normalizeForCompare(hypothesis);
  if (!r.length) return 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return Math.max(0, 1 - d[r.length][h.length] / r.length);
}

/**
 * Did the transcript contain each expected item (string or list of acceptable strings)? Compared on
 * normalised words; each expected word may match the start of a heard word ("finish" ~ "finished"),
 * but not the middle ("time" doesn't match "sometimes").
 */
export function vocabHits(transcript, expect = []) {
  const heard = normalizeForCompare(transcript);
  const has = (option) => {
    const want = normalizeForCompare(option);
    if (!want.length) return false;
    for (let i = 0; i + want.length <= heard.length; i++) {
      if (want.every((w, k) => heard[i + k].startsWith(w))) return true;
    }
    return false;
  };
  return expect.map((e) => (Array.isArray(e) ? e : [e]).some(has));
}

/**
 * features(transcript, { speechSec, kind, reference, expect, timing })
 * timing (measured from the mic in the browser, more precise than the transcript's segment times):
 *   { spanSec: first to last voiced moment, voicedSec, pauses: [pause lengths ≥ 0.25 s, in seconds] }
 */
export function features(transcript, { speechSec = 0, kind, reference, expect, timing } = {}) {
  const w = words(transcript);
  const chars = (transcript || '').replace(/\s/g, '').length || 1;
  const latinWords = w.filter((x) => /^[a-z'-]+$/.test(x));
  const f = {
    wordCount: w.length,
    englishWordCount: latinWords.length,
    devanagariRatio: ((transcript || '').match(DEVANAGARI) || []).length / chars,
    nonLatinRatio: ((transcript || '').match(INDIC) || []).length / chars,
    wpm: speechSec > 0.5 ? (w.length / speechSec) * 60 : 0,
    fillerRate: w.length ? ((transcript || '').match(FILLERS) || []).length / w.length : 0,
    uniqueRatio: w.length ? new Set(w).size / w.length : 0,
    avgWordLen: latinWords.length ? latinWords.join('').length / latinWords.length : 0,
    longWords: latinWords.filter((x) => x.length >= 9).length,
    complexMarkers: ((transcript || '').match(COMPLEX_MARKERS) || []).length,
  };
  if (kind === 'read' && reference) f.readAccuracy = readAccuracy(reference, transcript);
  if ((kind === 'vocab' || kind === 'listen') && expect) f.vocabHits = vocabHits(transcript, expect);
  // Fluency from the mic: how fast they speak, how often and how long they stop, and how many words come
  // between stops (a "run"). Fluent speech: long runs, few long pauses.
  if (timing?.spanSec > 0.5 && w.length) {
    const pauses = (timing.pauses || []).filter((p) => p >= 0.25);
    f.speechRate = (w.length / timing.spanSec) * 60;                       // words per minute, pauses included
    f.articulationRate = timing.voicedSec > 0.3 ? (w.length / timing.voicedSec) * 60 : f.speechRate;
    f.pauses = pauses.length;
    f.longPauses = pauses.filter((p) => p >= 1).length;                     // a second or more mid-answer
    f.meanRun = +(w.length / (pauses.length + 1)).toFixed(1);               // words between pauses
    f.wpm = f.speechRate;
  }
  return f;
}

const clamp = (x, lo = 0, hi = 4) => Math.max(lo, Math.min(hi, x));

/** Feature-only dimension scores (0..4). Used alone in demo mode or if the LLM fails. */
export function heuristicScores(f, kind) {
  const english = f.nonLatinRatio > 0.5 ? 0 : 1;
  const fillers = 1 - Math.min(0.5, f.fillerRate * 2);
  // With mic timing: speed (60%) and words between pauses (40%), minus long stops. Without: words per minute.
  const fluency = english * (f.meanRun != null
    ? clamp((0.6 * clamp((f.speechRate - 40) / 22) + 0.4 * clamp(f.meanRun / 2.5)) * fillers - Math.min(1, f.longPauses * 0.3))
    : clamp((f.wpm - 40) / 25) * fillers);
  const vocab = english * clamp(0.5 + f.englishWordCount / 15 + f.longWords * 0.5 + Math.max(0, f.avgWordLen - 4) * 0.6);
  const grammar = english * clamp(f.englishWordCount < 3 ? 0.5 : 1.5 + f.complexMarkers * 0.6 + Math.min(1.5, f.wordCount / 30));
  const coherence = english * clamp(f.wordCount < 5 ? 0.5 : 1.5 + f.complexMarkers * 0.8 + Math.min(1, f.wordCount / 50));
  // Pronunciation is only measured where there's something to compare with: reading a known sentence. Elsewhere
  // it's left out (null) rather than guessed.
  const s = { comprehension: f.wordCount ? 3 : 0, vocabulary: vocab, grammar, fluency, pronunciation: null, coherence };
  if (kind === 'read') s.pronunciation = clamp((f.readAccuracy ?? 0) * 4.2);
  if (kind === 'listen' && f.vocabHits) s.comprehension = f.vocabHits.some(Boolean) ? 4 : 1;
  if (kind === 'vocab' && f.vocabHits) {
    const hit = f.vocabHits.filter(Boolean).length / f.vocabHits.length;
    s.vocabulary = clamp(hit * 4);
    s.comprehension = clamp(1 + hit * 3);
  }
  return s;
}

const DIMS = ['comprehension', 'vocabulary', 'grammar', 'fluency', 'pronunciation', 'coherence'];

/**
 * How much of each skill comes from the AI judge (the rest from measured features). Grammar and joining ideas
 * lean on the judge: the word-counting features can't tell a fluent C1 answer from a long B1 one (their ceiling
 * is about 2.5 without textbook linking words). Fluency keeps half from the real mic timing.
 */
export const JUDGE_WEIGHT = CONFIG.judgeWeight; // the defaults; blend() uses the live values

/** Blend LLM and heuristic scores per skill (JUDGE_WEIGHT). */
export function blend(llm, heur) {
  const out = {};
  for (const d of DIMS) {
    if (heur[d] == null) { out[d] = null; continue; } // not measured for this kind of answer
    const l = llm?.[d] == null ? NaN : Number(llm[d]), w = C.judgeWeight[d];
    out[d] = Number.isFinite(l) ? w * clamp(l) + (1 - w) * heur[d] : heur[d];
  }
  return out;
}

/** Provisional level from Q1 alone, used to choose Q2–Q4 variants. */
export function provisionalLevel(f, scores) {
  if ((f.nonLatinRatio ?? f.devanagariRatio) > 0.5 || f.englishWordCount < 3) return 1;
  const avg = (scores.vocabulary + scores.grammar + scores.fluency + scores.coherence) / 4;
  if (avg >= C.firstGuess.level4Score && f.wordCount >= C.firstGuess.level4Words) return 4;
  if (avg >= C.firstGuess.level3Score) return 3;
  return 2;
}

/**
 * Final placement.
 * @param answers [{ questionId, variantLevel, kind, features, scores, neededHindi, skipped }]
 */
export function finalLevel(answers) {
  const by = Object.fromEntries(answers.map((a) => [a.questionId, a]));
  const all = answers.filter((a) => !a.skipped);
  if (!all.length) return { level: 1, reasons: ['No usable answers'], dims: {} };

  // Each skill is averaged over the answers that measured it (pronunciation: read-aloud only).
  const dims = {};
  for (const d of DIMS) {
    const got = all.map((a) => a.scores[d]).filter((v) => v != null);
    if (got.length) dims[d] = got.reduce((x, y) => x + y, 0) / got.length;
  }
  // Harder variants earn credit: answering an L4 item well means more than an L2 item.
  const difficulty = all.reduce((s, a) => s + (a.variantLevel ?? 2), 0) / all.length;
  const measured = Object.values(dims);
  const overall = measured.reduce((x, y) => x + y, 0) / measured.length;
  const adjusted = overall + (difficulty - 2) * C.difficultyBonus;

  const cut = C.levelCutoffs;
  let level = adjusted >= cut.level4 ? 4 : adjusted >= cut.level3 ? 3 : adjusted >= cut.level2 ? 2 : 1;
  const reasons = [];

  const q1 = by.q1_intro, q2 = by.q2_vocab, q3 = by.q3_read, q4 = by.q4_opinion;
  if (q1 && (q1.features.nonLatinRatio ?? q1.features.devanagariRatio) > 0.5 && q2 && q2.variantLevel === 1 && !(q2.features.vocabHits || []).some(Boolean)) {
    level = 1; reasons.push('Answered in Hindi and missed the basic vocabulary items');
  }
  if (q3?.features.readAccuracy != null && q3.features.readAccuracy < C.readAccuracyCap && level > 2) {
    level = 2; reasons.push(`Read-aloud accuracy below ${Math.round(C.readAccuracyCap * 100)}%`);
  }
  // Level 4 needs strong English words and joining of ideas when speaking at length: averaged over the opinion
  // answer and its follow-up (one short answer shouldn't decide it).
  const talk = answers.filter((a) => (a.questionId === 'q4_opinion' || a.questionId === 'q4_opinion_followup') && !a.skipped);
  const avg = (d) => (talk.length ? talk.reduce((x, a) => x + (a.scores[d] ?? 0), 0) / talk.length : 0);
  if (level === 4 && !(avg('coherence') >= C.level4Talk && avg('vocabulary') >= C.level4Talk)) {
    level = 3; reasons.push('Level 4 needs strong words and well-joined ideas in the longer answers');
  }
  if (answers.filter((a) => a.neededHindi).length >= C.hindiHelpCap && level > 2) {
    level = 2; reasons.push(`Needed Hindi instructions on ${C.hindiHelpCap} or more questions`);
  }
  return { level, overall: +adjusted.toFixed(2), dims, reasons, talk: { coherence: +avg('coherence').toFixed(2), vocabulary: +avg('vocabulary').toFixed(2) } };
}
