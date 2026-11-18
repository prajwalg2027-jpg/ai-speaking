import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAsk, checkReaction, stripVerdicts } from '../server/tutor.js';
import { QUESTIONS } from '../shared/assessment.js';

const vocab3 = { tutor: QUESTIONS[1].variants[3].tutor };
const read = { tutor: QUESTIONS[2].tutor, reference: QUESTIONS[2].variants[3].screen };

test('task lines must keep the task words', () => {
  assert.equal(checkAsk("At work, what's zimmedari in English? And what does deadline mean?", vocab3).ok, true);
  assert.match(checkAsk('What does deadline mean?', vocab3).reason, /missing/);
  assert.equal(checkAsk('ज़िम्मेदारी को English में क्या कहेंगे? And deadline?', vocab3).ok, true);
});

test('task lines must never give away the answer', () => {
  assert.match(checkAsk('Zimmedari means responsibility, right? And what is a deadline?', vocab3).reason, /gives away "responsibility"/);
  const l1 = { tutor: QUESTIONS[1].variants[1].tutor };
  assert.match(checkAsk("Look at this picture of a सेब. And what's paani in English?", l1).reason, /gives away/);
});

test('read-aloud lines must not say the sentence', () => {
  assert.equal(checkAsk('Please read the sentence on your screen out loud.', read).ok, true);
  assert.match(checkAsk('Read this out: although the weather was terrible.', read).reason, /reads the sentence out/);
});

test('follow-ups must be questions; summaries must name the level', () => {
  assert.match(checkAsk('Tell me more.', { followup: true, tutor: {} }).reason, /not a question/);
  assert.equal(checkAsk('What do you teach?', { followup: true, tutor: {} }).ok, true);
  assert.match(checkAsk('Great chatting!', { summary: { levelName: 'Conversational' }, tutor: {} }).reason, /level name/);
});

test('reactions react to what was said, never how well', () => {
  assert.equal(checkReaction('Two hours in traffic sounds exhausting, Prajwal.'), 'Two hours in traffic sounds exhausting, Prajwal.');
  assert.equal(checkReaction('Perfect answer, Prajwal.'), '');
  assert.equal(checkReaction("That's right, you should say 'went' instead."), '');
  assert.equal(checkReaction('What do you teach?'), '', 'no questions in the reaction');
  assert.equal(stripVerdicts('You know so many English words already, Raju. Now look at the picture.'), 'Now look at the picture.');
});
