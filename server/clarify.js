// Detects when the user is asking for clarification rather than answering.
// Layer 1: fast lexical match (English / Hinglish / Devanagari). Layer 2 (in index.js): LLM fallback.

const PATTERNS = [
  ['in_hindi', /\b(hindi (me|mein|main)|in hindi)\b|हिंदी में|हिन्दी में/i],
  ['slower', /\b(slow(ly|er)?|dheere|dheere|dhire)\b|धीरे/i],
  ['dont_know', /\b(i ?don'?t know|no idea|pata nahi|pata nahin|nahi pata|maloom nahi)\b|पता नहीं|मालूम नहीं/i],
  ['repeat', /\b(what\??|sorry\??|pardon|repeat|again|come again|say that again|samajh nahi|samajh nahin|samjha nahi|nahi samjha|nahin samjha|phir se|fir se|dobara|kya\??)\b|समझ नहीं|फिर से|दोबारा|क्या\?/i],
];

/**
 * @returns {null | 'repeat' | 'slower' | 'in_hindi' | 'dont_know'}
 * Only short utterances are treated as clarification requests: a long answer
 * that happens to contain "again" is still an answer.
 */
export function detectClarification(transcript) {
  const t = (transcript || '').trim();
  if (!t) return null;
  const words = t.split(/\s+/).length;
  if (words > 8) return null;
  for (const [intent, re] of PATTERNS) if (re.test(t)) return intent;
  return null;
}

/** Is this transcript too short / empty to evaluate? */
export function isUnintelligible(transcript) {
  const t = (transcript || '').replace(/[^\p{L}\p{N}]/gu, '');
  return t.length < 2;
}

/** Heuristic: answer likely cut off by VAD (short, no terminal punctuation, ends on a connector). */
export function looksTruncated(transcript, speechSec) {
  const t = (transcript || '').trim();
  if (!t || speechSec > 12) return false;
  return /\b(and|but|because|so|the|a|to|of|with|my|i|or|which|that)$/i.test(t);
}
