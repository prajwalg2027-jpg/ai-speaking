import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForCompare as n } from '../server/normalize.js';
import { readAccuracy, vocabHits } from '../server/scoring.js';

test('mic test regressions: formatting no longer counts as a mistake', () => {
  // The three sentences that lost points on the 17 Nov mic test only because of formatting.
  assert.equal(readAccuracy('Every morning I take the bus to work, and it is always crowded.', "Every morning I take the bus to work and it's always crowded."), 1);
  assert.equal(readAccuracy("Vikram's van went west on Wednesday with seven heavy bags.", "Vikram's van went west on Wednesday with 7 heavy bags."), 1);
  assert.equal(readAccuracy('I paid two hundred and fifty rupees for three thick notebooks.', 'I paid ₹250 for three thick notebooks.'), 1);
});

test('numbers, currency, percent, time and ordinals', () => {
  assert.deepEqual(n('two hundred and fifty'), ['250']);
  assert.deepEqual(n('Rs. 250'), ['250', 'rupees']);
  assert.deepEqual(n('one lakh fifty thousand'), n('1,50,000'));
  assert.deepEqual(n('twenty-five'), ['25']);
  assert.deepEqual(n('a hundred'), ['100']);
  assert.deepEqual(n('seven thirty'), n('7:30')); // two numbers, not 37
  assert.deepEqual(n('the twenty-first'), n('the 21st'));
  assert.deepEqual(n('fifty per cent'), n('50%'));
  assert.deepEqual(n('two point five'), ['2.5']);
  assert.deepEqual(n('२५०'), ['250']);
});

test('contractions expand, possessives stay', () => {
  assert.deepEqual(n("it's"), ['it', 'is']);
  assert.deepEqual(n("can't"), n('cannot'));
  assert.deepEqual(n("they're"), ['they', 'are']);
  assert.deepEqual(n("Vikram's"), ["vikram's"]);
});

test('British and American spellings match', () => {
  assert.equal(readAccuracy('They thought the theatre was three streets away.', 'They thought the theater was 3 streets away.'), 1);
});

test('real mistakes still count', () => {
  assert.ok(readAccuracy('He goes to the market.', 'He go to market.') < 0.7);
  assert.ok(readAccuracy('My name is Ravi. I like tea.', 'my name ravi like') < 0.7);
});

test('object property names are ordinary words', () => {
  assert.deepEqual(n('constructor toString'), ['constructor', 'tostring']);
});

test('vocabulary matching: word starts, normalised, not mid-word', () => {
  assert.deepEqual(vocabHits('I would say self reliant', [['self-reliant', 'independent']]), [true]);
  assert.deepEqual(vocabHits('You must have finished it by then', [['finish']]), [true]);
  assert.deepEqual(vocabHits('Sometimes I forget', [['time']]), [false]);
  assert.deepEqual(vocabHits('ये पुस्तकालय है', [['pustakalay', 'पुस्तकालय']]), [true]);
});
