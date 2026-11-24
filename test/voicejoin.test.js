// One voice request per turn: a turn's lines joined, and what the app reports back mapped to the original lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinLines, mapInterruption } from '../server/voicejoin.js';
import { isHerLine } from '../server/guard.js';

const say = [
  { text: 'Oh, you went to the market!', lang: 'en-IN', pace: 1 },
  { text: 'What did you buy there?', lang: 'en-IN', pace: 1 },
  { text: 'आपने वहाँ क्या खरीदा?', lang: 'hi-IN', pace: 0.95 },
];

test('lines at the same pace are joined; a different pace stays apart; the card cue follows its words', () => {
  const j = joinLines(say, { line: 1, word: 0 });
  assert.deepEqual(j.say.map((l) => l.text), ['Oh, you went to the market! What did you buy there?', 'आपने वहाँ क्या खरीदा?']);
  assert.deepEqual(j.groups, [[0, 1], [2]]);
  assert.deepEqual(j.cue, { line: 0, word: 6 }, 'the question starts at the 7th word of the joined line');
});

test('Hindi joined to English: Sarvam, if it says the line, is told Hindi', () => {
  const j = joinLines([{ text: 'Very good.', lang: 'en-IN', pace: 1 }, { text: 'बहुत अच्छा।', lang: 'hi-IN', pace: 1 }]);
  assert.equal(j.say.length, 1); assert.equal(j.say[0].lang, 'hi-IN');
});

test('fixed lines (made once and kept) are never joined', () => {
  const fixed = new Set(['Shall we begin?']);
  const j = joinLines([{ text: 'Nice to meet you, Asha.', pace: 1 }, { text: 'Shall we begin?', pace: 1 }, { text: 'Tell me about your day.', pace: 1 }], null, (t) => fixed.has(t));
  assert.deepEqual(j.groups, [[0], [1], [2]]);
});

test('talking over a joined line: mapped to the original line and how much of it they heard', () => {
  const j = joinLines(say);
  const joined = { say: j.say, groups: j.groups, original: say };
  const first = say[0].text.length;
  // heard the whole first sentence and a few characters of the second
  const total = j.say[0].text.length / 14;
  const r = mapInterruption(joined, { index: 0, heardSec: total * (first + 1 + 8) / j.say[0].text.length });
  assert.equal(r.index, 1);
  assert.ok(Math.abs(r.heardSec - 8 / 14) < 0.1, `${r.heardSec}`);
  assert.deepEqual(mapInterruption(joined, { index: 1, heardSec: 0.5 }).index, 2);
  assert.equal(mapInterruption(null, { index: 1, heardSec: 2 }).index, 1, 'nothing joined: unchanged');
});

test("a joined line is one of hers: the voice may say it", () => {
  const s = { history: [{ who: 'sakhi', text: say[0].text }], voiceLines: ['Oh, you went to the market! What did you buy there?'] };
  assert.ok(isHerLine('Oh, you went to the market! What did you buy there?', s, new Set()));
  assert.ok(!isHerLine('Something she never said.', s, new Set()));
});
