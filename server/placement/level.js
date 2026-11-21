// The level rule for the conversation placement. All of it is here, in plain code:
//
//   Each answer gets a level, 1 to 4 (the AI reads the answer against the ladder in brain.js).
//   The result is THE HIGHEST LEVEL THEY REACHED IN TWO ANSWERS.
//
//   Which question comes next:
//     Hello       "What's your name?" Not counted.
//     Question 1  an easy closed question (a word or two answers it), so nobody starts on a hard one.
//     Question 2  one level above their first answer (can they go higher?).
//     After 2     same level twice: finished. Otherwise question 3, at the higher of the two.
//     After 3     finished, unless the third answer was above the level so far: then one last question at it.
//     Never more than `maxQuestions`.
//
//   Four checks on what was measured (not the AI's opinion):
//     One answer mostly not in English, or under 3 English words   →  that answer is level 1.
//     One answer under 8 English words                             →  that answer is level 2 at most.
//     Almost no English spoken in the whole talk (under 5 words)   →  level 1.
//     Too little English to be sure (under 25 words)               →  level 2 at most.
//
// A question they couldn't answer after help counts as one level below that question's level.

export const WARM_UP = 1;         // the first counted question is closed and easy: a word or two answers it
export const MIN_ENGLISH = 5;     // fewer English words than this in the whole talk: level 1
export const ENOUGH_ENGLISH = 25; // fewer than this: level 2 at most

const secondHighest = (levels) => [...levels].sort((a, b) => b - a)[1];

/**
 * What comes after these answers. ratings: [{ level }] in the order asked.
 * → { done: true } or { done: false, target } (the level to pitch the next question at)
 */
export function nextStep(ratings, maxQuestions = 4) {
  const levels = ratings.map((r) => r.level), n = levels.length;
  if (n === 0) return { done: false, target: WARM_UP };
  if (n >= maxQuestions) return { done: true };
  if (n === 1) return { done: false, target: Math.min(4, levels[0] + 1) };
  if (n === 2) return levels[0] === levels[1] ? { done: true } : { done: false, target: Math.max(...levels) };
  const last = levels[n - 1];
  return last > secondHighest(levels) ? { done: false, target: last } : { done: true };
}

/** One answer's level, held to what was measured: a few words can't show a high level. f: features() of the answer. */
export function clampLevel(level, f = {}) {
  const words = f.englishWordCount ?? 0;
  if ((f.nonLatinRatio ?? 0) > 0.5 || words < 3) return 1;
  return words < 8 ? Math.min(level, 2) : level;
}

/** The level a missed question counts as (couldn't answer it, even with help). */
export const missedLevel = (target) => Math.max(1, target - 1);

/**
 * The result. ratings: [{ level, englishWords }].
 * → { level, reasons: [plain sentences saying why] }
 */
export function placementLevel(ratings) {
  const levels = ratings.map((r) => r.level);
  if (!levels.length) return { level: 1, reasons: ['No answers to go on.'] };
  let level = levels.length === 1 ? levels[0] : secondHighest(levels);
  const reasons = [levels.length === 1 ? `One answer, at level ${level}.` : `Answers were at levels ${levels.join(', ')}: level ${level} was reached twice.`];
  const english = ratings.reduce((n, r) => n + (r.englishWords || 0), 0);
  if (english < MIN_ENGLISH && level > 1) { level = 1; reasons.push(`Only ${english} English words in the whole talk.`); }
  else if (english < ENOUGH_ENGLISH && level > 2) { level = 2; reasons.push(`Only ${english} English words in the whole talk: too little to place higher.`); }
  return { level, reasons };
}
