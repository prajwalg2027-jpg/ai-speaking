// One voice request per turn (admin settings › Sakhi's voice › "one request per turn"): Sakhi's lines in a turn
// are joined into one line before the app gets the turn, so the app asks for her voice once, not once per line.
// Google's Gemini voices are limited by requests a minute (10 on the free trial), so this fits about three times
// as many turns. The cost: her first sound waits for the whole turn's voice to start, and her reaction is no longer
// said before the rest of the turn is written.
//
// Lines are joined only when they are not fixed lines (those are made once and kept, so they cost no request) and
// they are said at the same pace. What the app reports back about a joined line (where the learner talked over
// her, where the card appears) is mapped to the lines the conversation knows.

const CHARS_A_SECOND = 14; // how the conversation estimates a line's length when it has no sound for it

/**
 * say: [{text, lang, pace}], cue: {line, word} | null, isFixed(text) → boolean
 * → { say, cue, groups } where groups[j] lists the indexes in the original say that line j of the new say holds.
 */
export function joinLines(say = [], cue = null, isFixed = () => false) {
  const out = [], groups = [];
  say.forEach((l, i) => {
    const last = out.at(-1), g = groups.at(-1);
    const joinable = !isFixed(l.text) && last && !isFixed(say[g.at(-1)].text) && (last.pace ?? 1) === (l.pace ?? 1);
    if (joinable) {
      last.text = `${last.text} ${l.text}`;
      if (/[ऀ-ॿ]/.test(l.text)) last.lang = 'hi-IN'; // Sarvam, if it says this line: Hindi reads English too
      g.push(i);
    } else { out.push({ ...l }); groups.push([i]); }
  });
  let newCue = cue;
  if (cue && Number.isInteger(cue.line)) {
    const j = Math.max(0, groups.findIndex((g) => g.includes(cue.line)));
    const before = groups[j]?.filter((i) => i < cue.line).reduce((n, i) => n + words(say[i].text), 0) || 0;
    newCue = { ...cue, line: j, word: before + (cue.word || 0) };
  }
  return { say: out, cue: newCue, groups };
}

const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * The app says the learner talked over line `index` of the joined turn after `heardSec` seconds of it. → the same
 * moment in the original lines: { index, heardSec }, so the conversation's own reckoning works unchanged.
 * joined: { say, groups, original } as kept from the last turn. secondsOf(line) → seconds of sound, or null.
 */
export function mapInterruption(joined, interrupted, secondsOf = () => null) {
  if (!joined || !interrupted) return interrupted;
  const j = Math.max(0, Math.min(joined.groups.length - 1, Number(interrupted.index) || 0));
  const line = joined.say[j], group = joined.groups[j];
  const total = secondsOf(line) || line.text.length / CHARS_A_SECOND;
  let chars = Math.round(line.text.length * Math.max(0, Math.min(1, (Number(interrupted.heardSec) || 0) / total)));
  for (const i of group) {
    const len = joined.original[i].text.length;
    if (chars <= len || i === group.at(-1)) {
      const o = joined.original[i], seconds = secondsOf(o) || len / CHARS_A_SECOND;
      return { index: i, heardSec: (Math.min(chars, len) / len) * seconds };
    }
    chars -= len + 1; // and the space between them
  }
  return interrupted;
}
