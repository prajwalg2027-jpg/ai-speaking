// The result screen's detailed feedback (server/placement/insights.js): what is kept from the AI's answer, the
// word-by-word differences, the app's own counts, and how a sentence said back is marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, countsOf, usableInsights, sayable, sayBackScore, buildInsights, answersOf } from '../server/placement/insights.js';

const answers = [
  { question: 'What did you do this morning?', transcript: 'I wake up at six and I make tea for my family, then I go to shop.' },
  { question: 'Why do you like your work?', transcript: 'I like because I meet many peoples and I am talking with them whole day.' },
  { question: 'What would you do on a free day?', transcript: 'I will go to my village and meet my mother, because I am not seeing her since two months.' },
];

test('a word-by-word difference: what was taken out, what was put in, the rest joined', () => {
  assert.deepEqual(wordDiff('I go to shop yesterday.', 'I went to the shop yesterday.'), [
    { t: 'I', k: 'same' }, { t: 'go', k: 'del' }, { t: 'went', k: 'add' }, { t: 'to', k: 'same' }, { t: 'the', k: 'add' }, { t: 'shop yesterday.', k: 'same' },
  ]);
  assert.deepEqual(wordDiff('Hello there', 'hello, there!'), [{ t: 'hello, there!', k: 'same' }], 'case and punctuation are not a change');
});

test('the counts come from their words, not the AI', () => {
  const c = countsOf([...answers.map((a) => a.transcript), 'मैं market जाता हूँ yaar']);
  assert.equal(c.answers, 4);
  assert.equal(c.longestAnswer, 19);
  assert.deepEqual(c.joiningWords, ['and', 'because', 'then']);
  assert.equal(c.hindiWords, 4, 'Devanagari words and common Hindi in English letters');
  assert.equal(c.englishWords, 17 + 15 + 19 + 1);
});

test("only the parts of the AI's answer that hold up are kept", () => {
  const data = {
    answers: [
      { i: 1, better: 'I woke up at six and made tea for my family, then I went to the shop.', why: "It already happened, so 'wake' becomes 'woke'.", up: 'I woke up at six, made tea for everyone, and then went to the shop.', upAdds: ['richer words', 'made up'] },
      { i: 1, better: 'a second one for the same answer' },
      { i: 9, better: 'an answer that does not exist' },
      { i: 3, better: answers[2].transcript.toUpperCase(), why: 'Nothing changed.', up: answers[2].transcript },
    ],
    best: { i: 3, quote: '"I will go to my village and meet my mother"', tags: ['talked about the future', 'nice'], why: 'You talked about a plan.' },
    ladder: ['Village.', 'I go village.', 'I will go to my village.', 'I would love to go back to my village.'],
    habit: { name: "Using '-ing' too often", rule: 'For every day, use the simple form.', examples: [
      { said: 'I am talking with them', better: 'I talk with them' }, { said: 'I am not seeing her', better: "I haven't seen her" }, { said: 'never said this', better: 'x y' }] },
    tip: { title: "'since' or 'for'?", said: 'since two months', better: 'for two months', rule: "'for' + how long, 'since' + when it started.", hindi: "'for' के बाद कितना समय।" },
  };
  const u = usableInsights(data, answers, 3);
  assert.deepEqual(u.answers.map((a) => a.i), [1, 3], 'one per answer, in order; none for an answer that does not exist');
  assert.deepEqual(u.answers[0].upAdds, ['richer words']);
  assert.ok(u.answers[0].diff.some((d) => d.k === 'add' && d.t === 'woke'));
  assert.deepEqual([u.answers[1].same, u.answers[1].why, u.answers[1].up], [true, null, null], 'already right: no "why", and an "up" that is no different is left out');
  assert.equal(u.best.quote, 'I will go to my village and meet my mother');
  assert.deepEqual(u.best.tags, ['talked about the future']);
  assert.deepEqual(u.ladder.rungs.map((r) => r.level), [1, 2, 3, 4]);
  assert.equal(u.ladder.you, 3);
  assert.equal(u.habit.examples.length, 2, 'an example not in their words is dropped');
  assert.equal(u.tip.better, 'for two months');
  assert.ok(sayable(u).includes('I talk with them') && sayable(u).includes('for two months'));

  const worse = usableInsights({ ...data, best: { quote: 'a sentence they never said at all' }, ladder: ['only', 'three', 'rungs'],
    habit: { ...data.habit, examples: data.habit.examples.slice(0, 1) }, tip: { ...data.tip, said: 'since Monday' },
    answers: [{ i: 1, better: 'Your grammar is fine.' }] }, answers, 3);
  assert.deepEqual(Object.keys(worse), [], 'a made-up quote, a short ladder, a habit seen once, a tip on words not said, and banned words are all dropped');
});

test('a sentence said back: each word heard or not', () => {
  const r = sayBackScore('I woke up at six and made tea.', 'i woke up at 6 and make tea');
  assert.deepEqual(r.words.filter((w) => !w.ok).map((w) => w.t), ['made']);
  assert.deepEqual([r.matched, r.total], [7, 8]);
  assert.ok(r.score > 0.8 && r.score < 1);
  assert.equal(sayBackScore('Hello there', '').matched, 0);
});

test('the AI failing leaves the counts, and says why', async () => {
  const s = { result: { level: 2 }, answers: answers.map((a) => ({ ...a, kind: 'open' })) };
  const r = await buildInsights(s, { structured: async () => { throw new Error('slow'); } });
  assert.deepEqual([r.status, r.level, r.counts.answers, r.fallback, r.answers], ['ready', 2, 3, 'slow', undefined]);
  const none = await buildInsights({ result: { level: 1 }, answers: [{ kind: 'open', transcript: 'हाँ' }] }, { structured: async () => assert.fail('no call without answers') });
  assert.equal(none.fallback, 'no spoken answers');
});

test('what the AI is given: the questions and their words, and the fixes already made', async () => {
  let sent;
  const s = { result: { level: 3 }, answers: [
    { kind: 'vocab', transcript: 'dog' }, { kind: 'read', transcript: 'I like to drink tea in the morning' },
    { kind: 'open', question: 'What did you do?', transcript: 'I go to the market today', tip: { said: 'I go', better: 'I went' } },
    { kind: 'open', skipped: true }] };
  assert.equal(answersOf(s).length, 1, 'only spoken answers to questions');
  await buildInsights(s, { structured: async ({ messages }) => { sent = messages[1].content; return { data: { answers: [{ i: 1, better: 'I went to the market today' }] }, provider: 'x', model: 'y' }; } });
  assert.match(sent, /THEIR LEVEL: 3 \(good\)/);
  assert.match(sent, /1\. Sakhi asked: What did you do\?\n {3}They said: I go to the market today/);
  assert.match(sent, /'I go' → 'I went'/);
});
