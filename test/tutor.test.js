import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAsk, checkReaction, stripVerdicts } from '../server/tutor.js';
import { QUESTIONS } from '../shared/assessment.js';

const vocab3 = { tutor: QUESTIONS[1].variants[3].tutor };
const read = { tutor: QUESTIONS[3].tutor, reference: QUESTIONS[3].variants[3].screen };

test('task lines must keep the task words', () => {
  assert.equal(checkAsk("Here's a puzzle: if something is your duty, it's your… what? It starts with R.", vocab3).ok, true);
  assert.match(checkAsk('What is this word?', vocab3).reason, /missing/);
});

test('task lines must never give away the answer', () => {
  assert.match(checkAsk('Your duty is your responsibility, right?', vocab3).reason, /gives away "responsibility"/);
  const l1 = { tutor: QUESTIONS[1].variants[1].tutor };
  assert.match(checkAsk('Look at this picture of a सेब. What is it in English?', l1).reason, /gives away/);
});

test('a listening lead-in must not give away the sentences or the question', () => {
  const v = QUESTIONS[2].variants[2], listen = { tutor: QUESTIONS[2].tutor, secret: `${v.passage} ${v.question}` };
  assert.equal(checkAsk("Now listen carefully: I'll say two short sentences, then ask one question.", listen).ok, true);
  assert.match(checkAsk('Listen: Meena wakes up at six every day.', listen).reason, /reads the sentence out/);
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

test('names: only the name the learner gave is used to address them', async () => {
  const { stripInventedNames: g } = await import('../server/tutor.js');
  assert.equal(g('Thank you, Riya.', null), 'Thank you.');
  assert.equal(g('Riya, what did you do last weekend?', null), 'What did you do last weekend?');
  assert.equal(g('Thanks Riya! Now, tell me more.', null), 'Thanks! Now, tell me more.');
  assert.equal(g('That sounds busy, Riya ji.', 'Prajwal'), 'That sounds busy.');
  assert.equal(g('That sounds busy, Prajwal!', 'Prajwal'), 'That sounds busy, Prajwal!');
  assert.equal(g('Okay, tell me more. Honestly, that sounds fun.', null), 'Okay, tell me more. Honestly, that sounds fun.');
});

test('apologies survive the verdict filter; verdicts do not', async () => {
  const { stripVerdicts: v } = await import('../server/tutor.js');
  assert.equal(v("Sorry, my mistake! You're right."), "Sorry, my mistake! You're right.");
  assert.equal(v('That is correct! What next?'), 'What next?');
  assert.equal(v('You made a small mistake. Try again.'), 'Try again.');
});

test('Hindi verdicts are removed too, Hindi apologies are not', () => {
  assert.equal(stripVerdicts('ठीक है, यह बिल्कुल सही है। अब library को हिंदी में क्या कहते हैं?'), 'अब library को हिंदी में क्या कहते हैं?');
  assert.equal(stripVerdicts('माफ़ी चाहती हूँ, मुझसे ग़लती हो गई।'), 'माफ़ी चाहती हूँ, मुझसे ग़लती हो गई।');
});

test('one question per line: later questions are dropped, instructions stay', async () => {
  const { oneQuestion } = await import('../server/tutor.js');
  assert.equal(oneQuestion("What food do you enjoy? Try starting with 'I like'."), "What food do you enjoy? Try starting with 'I like'.");
  assert.equal(oneQuestion('Who did you party with? What did you all do together?'), 'Who did you party with?');
  assert.equal(oneQuestion('There is a sentence on your screen. Can you read it out loud? Are you ready?', { reference: 'x' }), 'There is a sentence on your screen. Can you read it out loud?');
  assert.equal(oneQuestion('Please read the sentence on your screen. Are you ready?', { reference: 'x' }), 'Please read the sentence on your screen.');
});

test('a listening lead-in has no question; comments on how they spoke are dropped', async () => {
  const { oneQuestion } = await import('../server/tutor.js');
  assert.equal(oneQuestion("I'll say two short sentences, so listen carefully. Do you like your work?", { kind: 'listen' }), "I'll say two short sentences, so listen carefully.");
  assert.equal(stripVerdicts('You used she, which is nice. Now listen.'), 'Now listen.');
});

