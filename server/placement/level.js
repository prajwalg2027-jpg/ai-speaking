// THE SAFETY NET for the conversation placement. In the normal course the AI decides everything, the final level
// included (brain.js). This rule is only used when the AI is slow, fails, or leaves the level out, so that a test
// still ends with a level. All of it is here, in plain code.
//
// The talk goes from easy to hard, so nobody starts on a hard question:
//   1. Hello     "Hi, my name is Sakhi. What is your name?"      Not counted.
//   2. Picture   "What is this called in English?"               Named it, or not.
//   3. Reading   One line on the screen, read out loud.          How many of its words came out right.
//                (An everyday line if they named the picture, a very simple one if not.)
//   4. Talking   Open questions, ONLY IF THEY QUALIFY: they named the picture, or read at least 70% of the line.
//                Each answer gets a level, 1 to 4 (the AI reads it against the ladder in brain.js).
//
// The result:
//   Didn't qualify (missed the picture and the reading)   →  level 1.
//   Qualified                                             →  level 2 at least; higher from the talking:
//                                                            THE HIGHEST LEVEL REACHED IN TWO ANSWERS.
//
// How many open questions:
//     The first is an everyday one (level 2). An answer at level 1 or 2 ends the talk there.
//     A stronger answer gets a second question, one level up.
//     After 2     same level twice: finished. Otherwise a third, at the higher of the two.
//     After 3     finished, unless the third answer was above the level so far: then one last question at it.
//     Never more than `maxQuestions`.
//
// Checks on what was measured (not the AI's opinion):
//     One answer mostly not in English, or under 3 English words   →  that answer is level 1.
//     One answer under 8 English words                             →  that answer is level 2 at most.
//     Under 25 English words in all the open answers               →  level 2 at most.
//
// An open question they couldn't answer after help counts as one level below that question's level.

export const READ_OK = 0.7;       // reading this share of the line's words right counts as reading it
export const OPEN_START = 2;      // the first open question is about everyday life
export const ENOUGH_ENGLISH = 25; // fewer English words than this in the open answers: level 2 at most

const secondHighest = (levels) => [...levels].sort((a, b) => b - a)[1];

/** May they go on to the open questions? */
export const qualifies = ({ picture, readAccuracy }) => !!picture || (readAccuracy ?? 0) >= READ_OK;

/**
 * What comes after these open answers. ratings: [{ level }] in the order asked.
 * → { done: true } or { done: false, target } (the level to pitch the next question at)
 */
export function nextStep(ratings, maxQuestions = 3) {
  const levels = ratings.map((r) => r.level), n = levels.length;
  if (n === 0) return { done: false, target: OPEN_START };
  if (n >= maxQuestions) return { done: true };
  if (n === 1) return levels[0] <= 2 ? { done: true } : { done: false, target: Math.min(4, levels[0] + 1) };
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

/** The level a missed open question counts as (couldn't answer it, even with help). */
export const missedLevel = (target) => Math.max(1, target - 1);

/**
 * The result. picture: named it? readAccuracy: 0..1 (null if not read). ratings: the open answers [{ level, englishWords }].
 * → { level, reasons: [plain sentences saying why] }
 */
export function placementLevel({ picture, readAccuracy, ratings = [] }) {
  const read = readAccuracy == null ? 'did not read the line' : `read ${Math.round(readAccuracy * 100)}% of the line`;
  const reasons = [`${picture ? 'Named the picture' : 'Did not name the picture'}; ${read}.`];
  if (!qualifies({ picture, readAccuracy })) return { level: 1, reasons };
  const levels = ratings.map((r) => r.level);
  if (!levels.length) { reasons.push('No open answers: level 2 for the picture and the reading.'); return { level: 2, reasons }; }
  let level = levels.length === 1 ? levels[0] : secondHighest(levels);
  reasons.push(levels.length === 1 ? `One open answer, at level ${level}.` : `Open answers were at levels ${levels.join(', ')}: level ${level} was reached twice.`);
  const english = ratings.reduce((n, r) => n + (r.englishWords || 0), 0);
  if (english < ENOUGH_ENGLISH && level > 2) { level = 2; reasons.push(`Only ${english} English words in the open answers: too little to place higher.`); }
  if (level < 2) { level = 2; reasons.push('Level 2 at least, for the picture and the reading.'); }
  return { level, reasons };
}
