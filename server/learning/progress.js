// Turning raw learning evidence into progress. Pure functions (tested on their own); server/learning/repo.js
// stores the results. Nothing here decides from one message: a concept's mastery needs repeated evidence, and the
// level estimate only moves with a lot of it.

/**
 * A concept's mastery from its evidence, oldest first: 1 = used correctly, 0 = a mistake, 0.5 = partly right.
 * Recent evidence counts more (each older item weighs 0.85× the next), with a neutral starting point (as if one
 * right and one wrong), so two or three answers can't make anything "mastered".
 */
export function skillFrom(outcomes) {
  let num = 1, den = 2, w = 1;
  for (let i = outcomes.length - 1; i >= 0; i--, w *= 0.85) { num += w * outcomes[i]; den += w; }
  const mastery = num / den;
  const correct = outcomes.filter((o) => o === 1).length;
  const mistakes = outcomes.filter((o) => o === 0).length;
  const recentMistake = outcomes.slice(-3).includes(0);
  const status = mastery >= 0.8 && correct >= 5 && !recentMistake ? 'mastered' : mastery >= 0.5 && correct >= 2 ? 'practising' : 'learning';
  return { mastery: +mastery.toFixed(3), correct, mistakes, status };
}

export const LEVEL_RULES = {
  minOutcomes: 80,       // scored items in the window before the level can move
  windowDays: 30,
  upAt: 0.85,            // weighted accuracy to move up one level
  downAt: 0.4,           // ... or down one
  minDaysBetween: 14,    // at most one move per two weeks
};

/**
 * The learner's level estimate. Starts from the placement test (the prior); moves one step at a time, and only
 * with enough recent evidence. → { level, confidence, changed, reason }
 */
export function estimateLevel({ placementLevel, currentLevel, outcomes, lastChangedAt, now = Date.now() }) {
  const level = currentLevel ?? placementLevel ?? null;
  const n = outcomes.length;
  const confidence = +Math.min(0.95, (placementLevel ? 0.5 : 0.2) + n / (LEVEL_RULES.minOutcomes * 2.5)).toFixed(2);
  if (!level) return { level: null, confidence: 0, changed: false, reason: 'no placement test yet' };
  if (n < LEVEL_RULES.minOutcomes) return { level, confidence, changed: false, reason: `needs ${LEVEL_RULES.minOutcomes - n} more scored answers` };
  if (lastChangedAt && now - new Date(lastChangedAt).getTime() < LEVEL_RULES.minDaysBetween * 86400_000) return { level, confidence, changed: false, reason: 'changed recently' };
  const accuracy = outcomes.reduce((a, b) => a + b, 0) / n;
  if (accuracy >= LEVEL_RULES.upAt && level < 4) return { level: level + 1, confidence, changed: true, reason: `${Math.round(accuracy * 100)}% right over ${n} answers` };
  if (accuracy <= LEVEL_RULES.downAt && level > 1) return { level: level - 1, confidence, changed: true, reason: `${Math.round(accuracy * 100)}% right over ${n} answers` };
  return { level, confidence, changed: false, reason: `${Math.round(accuracy * 100)}% right over ${n} answers` };
}

/** An outcome (0 / 0.5 / 1) for a learning event, or null if it isn't scored. */
export function outcomeOf(kind, detail = {}) {
  if (kind === 'mistake') return 0;
  if (kind === 'correct_use') return 1;
  if (kind === 'exercise_attempt') return detail.verdict === 'correct' ? 1 : detail.verdict === 'partly' ? 0.5 : 0;
  return null;
}
