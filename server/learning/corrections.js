// The correction policy: which of the corrections the AI proposed the learner actually sees. Pure functions,
// tested on their own (test/learning-corrections.test.js). The AI is told the same rules; this enforces them,
// because a wrong correction is worse than a missed one.
//
// In order: drop corrections of words the learner never wrote (invented), no-change ones, ones a speech-to-text
// slip could explain (voice), ones below the learner's chosen intensity, duplicates and overlaps; then keep the
// most important, up to the intensity's limit.

export const INTENSITY = {
  gentle: { minSeverity: 'important', categories: ['grammar', 'vocabulary', 'word_order'] },
  balanced: { minSeverity: 'moderate', categories: ['grammar', 'vocabulary', 'word_order', 'spelling', 'naturalness'] },
  strict: { minSeverity: 'minor', categories: ['grammar', 'vocabulary', 'word_order', 'spelling', 'naturalness'] },
};
const RANK = { minor: 0, moderate: 1, important: 2 };

/** Lower case, straight quotes, single spaces, no surrounding punctuation. */
export const norm = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/^[\s.,!?;:"']+|[\s.,!?;:"']+$/g, '');
const words = (s) => norm(s).split(/[\s.,!?;:"]+/).filter(Boolean);

const ARTICLES = new Set(['a', 'an', 'the']);
/** Two words that differ only by an ending speech-to-text often loses or adds (-s, -es, -ed, -d). */
function endingOnly(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l.startsWith(s) && ['s', 'es', 'ed', 'd', "'s"].includes(l.slice(s.length));
}

/**
 * Could this correction be explained by a speech-to-text slip rather than the learner's mistake? True when the
 * only differences are articles added or removed, word endings (-s/-es/-ed), capitals or punctuation.
 */
export function sttAmbiguous(original, corrected) {
  const a = words(original).filter((w) => !ARTICLES.has(w));
  const b = words(corrected).filter((w) => !ARTICLES.has(w));
  if (a.length !== b.length) return false;
  return a.every((w, i) => endingOnly(w, b[i]));
}

/**
 * @param {Array} corrections  validated corrections from the AI
 * @param {object} o
 * @param {string} o.learnerText   what the learner said or typed
 * @param {'gentle'|'balanced'|'strict'} o.intensity
 * @param {'text'|'voice'} o.channel
 * @param {boolean} o.voiceSafe    apply the speech-to-text filter for voice (admin setting)
 * @param {number} o.max           how many to show at most (admin setting per intensity)
 * @returns {{kept: Array, dropped: Array<{correction, reason}>}}
 */
export function applyPolicy(corrections, { learnerText, intensity = 'balanced', channel = 'text', voiceSafe = true, max = 3 }) {
  const rule = INTENSITY[intensity] || INTENSITY.balanced;
  const text = norm(learnerText);
  const kept = [], dropped = [];
  const drop = (correction, reason) => dropped.push({ correction, reason });

  for (const c of corrections || []) {
    const o = norm(c.original), n = norm(c.corrected);
    if (!o || !text.includes(o)) { drop(c, 'not in what the learner said'); continue; }
    if (o === n) { drop(c, 'no change'); continue; }
    if (channel === 'voice' && voiceSafe && (c.category === 'spelling' || sttAmbiguous(c.original, c.corrected))) { drop(c, 'could be a speech-to-text slip'); continue; }
    if (RANK[c.severity] < RANK[rule.minSeverity]) { drop(c, `below ${intensity} intensity`); continue; }
    if (!rule.categories.includes(c.category)) { drop(c, `${c.category} not shown at ${intensity} intensity`); continue; }
    // Same or overlapping words: keep the more important one.
    const clash = kept.findIndex((k) => { const ko = norm(k.original); return ko === o || ko.includes(o) || o.includes(ko); });
    if (clash >= 0) {
      if (RANK[c.severity] > RANK[kept[clash].severity]) { drop(kept[clash], 'duplicate'); kept[clash] = c; } else drop(c, 'duplicate');
      continue;
    }
    kept.push(c);
  }
  // Most important first, up to the limit.
  kept.sort((x, y) => RANK[y.severity] - RANK[x.severity]);
  for (const c of kept.splice(Math.max(0, max))) drop(c, 'over the limit for this intensity');
  return { kept, dropped };
}

/** Learning signals ("used the past tense correctly") only count when the evidence is the learner's own words. */
export function validSignals(signals, learnerText) {
  const text = norm(learnerText);
  return (signals || []).filter((s) => norm(s.evidence) && text.includes(norm(s.evidence)));
}
