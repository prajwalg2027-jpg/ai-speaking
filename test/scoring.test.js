import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAccuracy, features, heuristicScores, provisionalLevel, finalLevel, CONFIG } from '../server/scoring.js';
import { detectClarification, isUnintelligible, looksTruncated } from '../server/clarify.js';

test('read-aloud accuracy', () => {
  assert.equal(readAccuracy('My name is Ravi. I like tea.', 'my name is ravi i like tea'), 1);
  assert.ok(readAccuracy('My name is Ravi. I like tea.', 'my name ravi like') < 0.7);
});

test('clarification intents (English, Hinglish, Devanagari)', () => {
  assert.equal(detectClarification('Sorry?'), 'repeat');
  assert.equal(detectClarification('samajh nahi aaya'), 'repeat');
  assert.equal(detectClarification('हिंदी में बोलिए'), 'in_hindi');
  assert.equal(detectClarification('please speak slowly'), 'slower');
  assert.equal(detectClarification('pata nahi'), 'dont_know');
  assert.equal(detectClarification('I go to office and again come back home in the evening by metro train'), null);
  assert.equal(detectClarification('My name is Priya'), null);
});

test('unintelligible and truncated', () => {
  assert.ok(isUnintelligible(' . '));
  assert.ok(!isUnintelligible('hi'));
  assert.ok(looksTruncated('I would change the traffic because', 3));
  assert.ok(!looksTruncated('I would change the traffic.', 3));
});

const scoreOf = (t, opts = {}) => { const f = features(t, opts); return { f, s: heuristicScores(f, opts.kind) }; };

test('provisional routing from Q1', () => {
  let { f, s } = scoreOf('मेरा नाम राजू है, मैं दुकान पर काम करता हूँ', { speechSec: 4 });
  assert.equal(provisionalLevel(f, s), 1);
  ({ f, s } = scoreOf('My name Raju. I am... shop work.', { speechSec: 8 }));
  assert.equal(provisionalLevel(f, s), 2);
  ({ f, s } = scoreOf('Hi, my name is Priya. I work as a teacher in a primary school, and in the evenings I usually go for a walk with my friends.', { speechSec: 9 }));
  // A good answer as the AI judge scores it (about 3.5): at least the level-3 questions.
  assert.ok(provisionalLevel(f, { ...s, vocabulary: 3.5, grammar: 3.5, fluency: 3.5, coherence: 3.5 }) >= 3);
});

test('final level: Hindi + missed basics caps at L1', () => {
  const zero = { comprehension: 0, vocabulary: 0, grammar: 0, fluency: 0, pronunciation: 0, coherence: 0 };
  const r = finalLevel([
    { questionId: 'q1_intro', variantLevel: 2, features: { devanagariRatio: 0.9 }, scores: { ...zero, comprehension: 3 } },
    { questionId: 'q2_vocab', variantLevel: 1, features: { vocabHits: [false, false] }, scores: zero },
  ]);
  assert.equal(r.level, 1);
});

test('final level: L4 requires strong Q4', () => {
  const high = { comprehension: 4, vocabulary: 4, grammar: 4, fluency: 4, pronunciation: 4, coherence: 4 };
  const a = (id, scores) => ({ questionId: id, variantLevel: 4, features: { devanagariRatio: 0, readAccuracy: 0.98 }, scores });
  assert.equal(finalLevel([a('q1_intro', high), a('q2_vocab', high), a('q3_read', high), a('q4_opinion', high)]).level, 4);
  const weakQ4 = { ...high, coherence: CONFIG.level4Talk - 0.2, vocabulary: CONFIG.level4Talk + 0.3 }; // just under the talk check
  assert.equal(finalLevel([a('q1_intro', high), a('q2_vocab', high), a('q3_read', high), a('q4_opinion', weakQ4)]).level, 3);
});
