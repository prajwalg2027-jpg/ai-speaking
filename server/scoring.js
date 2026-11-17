// Deterministic speaking features + final level computation.
// The LLM judge is one input; the level decision itself is made here, in code.

import { normalizeForCompare } from './normalize.js';

const FILLERS = /\b(um+|uh+|erm|hmm+|like|matlab|basically|you know|wo|woh|toh)\b/gi;
const DEVANAGARI = /[ऀ-ॿ]/g;
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

export function features(transcript, { speechSec = 0, kind, reference, expect } = {}) {
  const w = words(transcript);
  const chars = (transcript || '').replace(/\s/g, '').length || 1;
  const latinWords = w.filter((x) => /^[a-z'-]+$/.test(x));
  const f = {
    wordCount: w.length,
    englishWordCount: latinWords.length,
    devanagariRatio: ((transcript || '').match(DEVANAGARI) || []).length / chars,
    wpm: speechSec > 0.5 ? (w.length / speechSec) * 60 : 0,
    fillerRate: w.length ? ((transcript || '').match(FILLERS) || []).length / w.length : 0,
    uniqueRatio: w.length ? new Set(w).size / w.length : 0,
    avgWordLen: latinWords.length ? latinWords.join('').length / latinWords.length : 0,
    longWords: latinWords.filter((x) => x.length >= 9).length,
    complexMarkers: ((transcript || '').match(COMPLEX_MARKERS) || []).length,
  };
  if (kind === 'read' && reference) f.readAccuracy = readAccuracy(reference, transcript);
  if (kind === 'vocab' && expect) f.vocabHits = vocabHits(transcript, expect);
  return f;
}

const clamp = (x, lo = 0, hi = 4) => Math.max(lo, Math.min(hi, x));

/** Feature-only dimension scores (0..4). Used alone in demo mode or if the LLM fails. */
export function heuristicScores(f, kind) {
  const english = f.devanagariRatio > 0.5 ? 0 : 1;
  const fluency = english * clamp((f.wpm - 40) / 25) * (1 - Math.min(0.5, f.fillerRate * 2));
  const vocab = english * clamp(0.5 + f.englishWordCount / 15 + f.longWords * 0.5 + Math.max(0, f.avgWordLen - 4) * 0.6);
  const grammar = english * clamp(f.englishWordCount < 3 ? 0.5 : 1.5 + f.complexMarkers * 0.6 + Math.min(1.5, f.wordCount / 30));
  const coherence = english * clamp(f.wordCount < 5 ? 0.5 : 1.5 + f.complexMarkers * 0.8 + Math.min(1, f.wordCount / 50));
  const s = { comprehension: f.wordCount ? 3 : 0, vocabulary: vocab, grammar, fluency, pronunciation: 2, coherence };
  if (kind === 'read') s.pronunciation = clamp((f.readAccuracy ?? 0) * 4.2);
  if (kind === 'vocab' && f.vocabHits) {
    const hit = f.vocabHits.filter(Boolean).length / f.vocabHits.length;
    s.vocabulary = clamp(hit * 4);
    s.comprehension = clamp(1 + hit * 3);
  }
  return s;
}

const DIMS = ['comprehension', 'vocabulary', 'grammar', 'fluency', 'pronunciation', 'coherence'];

/** Blend LLM and heuristic scores (LLM 60%, features 40%). */
export function blend(llm, heur) {
  const out = {};
  for (const d of DIMS) {
    const l = Number(llm?.[d]);
    out[d] = Number.isFinite(l) ? 0.6 * clamp(l) + 0.4 * heur[d] : heur[d];
  }
  return out;
}

/** Provisional level from Q1 alone, used to choose Q2–Q4 variants. */
export function provisionalLevel(f, scores) {
  if (f.devanagariRatio > 0.5 || f.englishWordCount < 3) return 1;
  const avg = (scores.vocabulary + scores.grammar + scores.fluency + scores.coherence) / 4;
  if (avg >= 3.2 && f.wordCount >= 35) return 4;
  if (avg >= 2.2) return 3;
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

  const dims = {};
  for (const d of DIMS) dims[d] = all.reduce((s, a) => s + a.scores[d], 0) / all.length;
  // Harder variants earn credit: answering an L4 item well means more than an L2 item.
  const difficulty = all.reduce((s, a) => s + (a.variantLevel ?? 2), 0) / all.length;
  const overall = (dims.vocabulary + dims.grammar + dims.fluency + dims.coherence + dims.comprehension + dims.pronunciation) / 6;
  const adjusted = overall + (difficulty - 2) * 0.35;

  let level = adjusted >= 3.1 ? 4 : adjusted >= 2.2 ? 3 : adjusted >= 1.2 ? 2 : 1;
  const reasons = [];

  const q1 = by.q1_intro, q2 = by.q2_vocab, q3 = by.q3_read, q4 = by.q4_opinion;
  if (q1 && q1.features.devanagariRatio > 0.5 && q2 && q2.variantLevel === 1 && !(q2.features.vocabHits || []).some(Boolean)) {
    level = 1; reasons.push('Answered in Hindi and missed the basic vocabulary items');
  }
  if (q3?.features.readAccuracy != null && q3.features.readAccuracy < 0.6 && level > 2) {
    level = 2; reasons.push('Read-aloud accuracy below 60%');
  }
  if (level === 4 && !(q4 && !q4.skipped && q4.scores.coherence >= 3.5 && q4.scores.vocabulary >= 3.5)) {
    level = 3; reasons.push('L4 needs strong coherence and vocabulary in the opinion question');
  }
  if (answers.filter((a) => a.neededHindi).length >= 2 && level > 2) {
    level = 2; reasons.push('Needed Hindi instructions on two or more questions');
  }
  return { level, overall: +adjusted.toFixed(2), dims, reasons };
}
