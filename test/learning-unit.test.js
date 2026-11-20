// The learning module's pure parts: the correction policy, progress maths, exact marking, prompts and the tutor turn
// (with a mocked AI). No database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicy, sttAmbiguous, validSignals, norm } from '../server/learning/corrections.js';
import { skillFrom, estimateLevel, outcomeOf, LEVEL_RULES } from '../server/learning/progress.js';
import { exactMark, normAnswer } from '../server/learning/lessons.js';
import { buildTutorMessages, buildVerifyMessages, PROMPT_VERSION } from '../server/learning/prompts.js';
import { tutorTurn } from '../server/learning/tutor.js';
import { TutorOutput } from '../server/learning/schemas.js';
import { SECTIONS } from '../server/settings.js';

const c = (original, corrected, extra = {}) => ({ original, corrected, category: 'grammar', concept: 'past_simple', explanation: 'x', severity: 'moderate', ...extra });

test('policy: corrections of words the learner never said, and no-change ones, are dropped', () => {
  const { kept, dropped } = applyPolicy([c('I go', 'I went'), c('he was went', 'he went'), c('Yesterday', 'yesterday')], { learnerText: 'Yesterday I go to market.', intensity: 'strict', max: 5 });
  assert.deepEqual(kept.map((k) => k.original), ['I go']);
  assert.deepEqual(dropped.map((d) => d.reason), ['not in what the learner said', 'no change']);
});

test('policy: intensity sets the minimum severity and the limit', () => {
  const list = [c('I go', 'I went', { severity: 'important' }), c('to market', 'to the market', { severity: 'minor', concept: 'articles' }), c('very much happy', 'very happy', { severity: 'moderate', category: 'vocabulary' })];
  const text = 'Yesterday I go to market, I was very much happy.';
  assert.deepEqual(applyPolicy(list, { learnerText: text, intensity: 'gentle', max: 1 }).kept.map((k) => k.original), ['I go']);
  assert.deepEqual(applyPolicy(list, { learnerText: text, intensity: 'balanced', max: 3 }).kept.map((k) => k.original), ['I go', 'very much happy']);
  assert.equal(applyPolicy(list, { learnerText: text, intensity: 'strict', max: 5 }).kept.length, 3);
  const limited = applyPolicy(list, { learnerText: text, intensity: 'strict', max: 2 });
  assert.deepEqual(limited.kept.map((k) => k.severity), ['important', 'moderate'], 'most important first');
  assert.equal(limited.dropped[0].reason, 'over the limit for this intensity');
});

test('policy: for speech, slips speech-to-text could cause are not corrected', () => {
  assert.equal(sttAmbiguous('to market', 'to the market'), true);
  assert.equal(sttAmbiguous('two book', 'two books'), true);
  assert.equal(sttAmbiguous('I walk yesterday', 'I walked yesterday'), true);
  assert.equal(sttAmbiguous('I go yesterday', 'I went yesterday'), false);
  assert.equal(sttAmbiguous('He don\'t', 'He doesn\'t'), false);
  const list = [c('to market', 'to the market', { concept: 'articles' }), c('I go', 'I went'), c('becuase', 'because', { category: 'spelling', concept: 'spelling' })];
  const text = 'Yesterday I go to market becuase I need rice';
  assert.deepEqual(applyPolicy(list, { learnerText: text, channel: 'voice', intensity: 'strict', max: 5 }).kept.map((k) => k.original), ['I go']);
  assert.equal(applyPolicy(list, { learnerText: text, channel: 'text', intensity: 'strict', max: 5 }).kept.length, 3, 'typed: all kept');
  assert.equal(applyPolicy(list, { learnerText: text, channel: 'voice', voiceSafe: false, intensity: 'strict', max: 5 }).kept.length, 3, 'filter can be switched off');
});

test('policy: overlapping corrections keep the more important one', () => {
  const { kept, dropped } = applyPolicy([c('I go to', 'I went to', { severity: 'moderate' }), c('I go', 'I went', { severity: 'important' })], { learnerText: 'I go to school', intensity: 'balanced', max: 3 });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].severity, 'important');
  assert.equal(dropped[0].reason, 'duplicate');
});

test('learning signals only count with the learner\'s own words as evidence', () => {
  const s = [{ kind: 'correct_use', concept: 'past_simple', evidence: 'I worked late' }, { kind: 'correct_use', concept: 'articles', evidence: 'an apple' }];
  assert.deepEqual(validSignals(s, 'Yesterday I worked late.').map((x) => x.concept), ['past_simple']);
  assert.equal(norm('  “Hello,” '), 'hello');
});

test('progress: mastery needs repeated evidence, and recent mistakes hold it back', () => {
  assert.equal(skillFrom([1, 1, 1]).status, 'practising', 'three right answers are not mastery');
  assert.equal(skillFrom([1, 1, 1, 1, 1, 1]).status, 'mastered');
  assert.equal(skillFrom([1, 1, 1, 1, 1, 1, 0]).status, 'practising', 'a recent mistake');
  assert.equal(skillFrom([0, 0]).status, 'learning');
  assert.ok(skillFrom([0, 0, 0, 1, 1, 1]).mastery > skillFrom([1, 1, 1, 0, 0, 0]).mastery, 'recent evidence counts more');
  assert.equal(outcomeOf('exercise_attempt', { verdict: 'partly' }), 0.5);
  assert.equal(outcomeOf('lesson_completed'), null);
});

test('progress: the level starts from the placement test and moves only with plenty of evidence', () => {
  const many = (v, n = LEVEL_RULES.minOutcomes) => Array(n).fill(v);
  assert.equal(estimateLevel({ placementLevel: 2, outcomes: many(1, 10) }).changed, false);
  assert.equal(estimateLevel({ placementLevel: 2, outcomes: many(1, 10) }).level, 2);
  const up = estimateLevel({ placementLevel: 2, outcomes: many(1) });
  assert.deepEqual([up.level, up.changed], [3, true]);
  assert.equal(estimateLevel({ placementLevel: 2, currentLevel: 3, outcomes: many(1), lastChangedAt: new Date() }).changed, false, 'one move per two weeks');
  assert.equal(estimateLevel({ placementLevel: 4, outcomes: many(1) }).level, 4, 'no level 5');
  assert.equal(estimateLevel({ placementLevel: 2, outcomes: many(0) }).level, 1);
  assert.equal(estimateLevel({ outcomes: many(1) }).level, null, 'no placement, no level');
});

test('lessons: exact answers are marked without the AI', () => {
  const fill = { kind: 'fill_blank', prompt: 'Yesterday I ___ (walk) to the market.', accepted_answers: ['walked'] };
  assert.equal(exactMark(fill, 'Walked')?.verdict, 'correct');
  assert.equal(exactMark(fill, 'Yesterday I walked to the market.')?.verdict, 'correct', 'the whole sentence');
  assert.equal(exactMark(fill, 'walk'), null, 'not settled: the AI judges');
  const choose = { kind: 'choose', options: ['a', 'an', 'the'], accepted_answers: ['the'], explanation: 'We both know which fan.' };
  assert.equal(exactMark(choose, 'the').verdict, 'correct');
  assert.equal(exactMark(choose, '3').verdict, 'correct', 'by number');
  assert.equal(exactMark(choose, 'a').verdict, 'incorrect');
  assert.match(exactMark(choose, 'a').feedback, /The answer is "the"/);
  assert.equal(exactMark(choose, 'banana').invalid, true);
  assert.equal(exactMark({ kind: 'free_response', accepted_answers: [] }, 'anything'), null);
  assert.equal(normAnswer("  I'm  HAPPY!! "), "i'm happy");
});

test('prompts: voice turns warn about speech-to-text, and the context is labelled', () => {
  const [sys, user] = buildTutorMessages({ profile: { name: 'Ravi', level: 2 }, memory: { recurring: [{ concept: 'articles', mistakes: 4 }], recentlyExplained: ['past_simple'] }, history: [{ role: 'tutor', content: 'Hi!' }], mode: 'conversation', channel: 'voice', intensity: 'gentle', message: 'i go market' });
  assert.match(sys.content, /SPOKE/);
  assert.match(sys.content, /GENTLE/);
  assert.match(sys.content, /articles \(4×\)/);
  assert.match(sys.content, /Ravi/);
  assert.match(user.content, /Sakhi: Hi!/);
  assert.match(user.content, /LAST message \(spoken\): i go market/);
  assert.doesNotMatch(buildVerifyMessages({ message: 'x', corrections: [c('x', 'y')], channel: 'text' })[0].content, /SPOKE/);
  assert.equal(PROMPT_VERSION, SECTIONS.conversation.defaults.promptVersion);
});

// ---- the tutor turn with a mocked AI ----

const settings = { corrections: SECTIONS.corrections.defaults, conversation: SECTIONS.conversation.defaults };
function mockAi({ tutor, verify }) {
  const calls = [];
  const structured = async ({ job, schema, messages }) => {
    calls.push({ job, messages });
    const data = schema.parse(job === 'tutor' ? tutor : typeof verify === 'function' ? verify() : verify);
    return { data, provider: 'mock', model: 'mock-1', latencyMs: 5, usage: { input: 1000, output: 100 }, attempts: 1 };
  };
  return { structured, calls };
}
const tutorOut = (corrections = [], extra = {}) => TutorOutput.parse({ reply: 'Nice! What did you buy?', corrections, encouragement: null, follow_up_question: 'What did you buy?', learning_signals: [], ...extra });

test('tutor turn, strategy A: one call, the policy filters, the reply goes out first', async () => {
  const ai = mockAi({ tutor: tutorOut([c('I go', 'I went', { severity: 'important' })]) });
  const order = [];
  const t = await tutorTurn({ structured: ai.structured, settings, strategy: 'single', message: 'Yesterday I go to market', onReply: (r) => order.push(['reply', r.reply]) });
  assert.deepEqual(ai.calls.map((x) => x.job), ['tutor']);
  assert.deepEqual(order, [['reply', 'Nice! What did you buy?']]);
  assert.equal(t.corrections.length, 1);
  assert.equal(t.verified, null);
  assert.equal(t.meta.strategy, 'single');
  assert.ok(t.meta.costInr > 0);
});

test('tutor turn, strategy B: the check runs only when there are corrections, and can drop them', async () => {
  const none = mockAi({ tutor: tutorOut([]), verify: { decisions: [] } });
  await tutorTurn({ structured: none.structured, settings, strategy: 'verify', message: 'I went to the market.' });
  assert.deepEqual(none.calls.map((x) => x.job), ['tutor'], 'no corrections → no check');

  const ai = mockAi({ tutor: tutorOut([c('I go', 'I went', { severity: 'important' }), c('market', 'the market', { severity: 'moderate', concept: 'articles' })]),
    verify: { decisions: [{ index: 0, keep: true, reason: 'right' }, { index: 1, keep: false, reason: 'fine as is' }] } });
  const t = await tutorTurn({ structured: ai.structured, settings, strategy: 'verify', message: 'Yesterday I go market' });
  assert.deepEqual(ai.calls.map((x) => x.job), ['tutor', 'verify']);
  assert.deepEqual(t.corrections.map((k) => k.original), ['I go']);
  assert.equal(t.verified, true);
  assert.match(t.dropped.find((d) => d.correction.original === 'market').reason, /check: fine as is/);
});

test('tutor turn, strategy B: if the check fails, corrections are withheld but the reply stands', async () => {
  const ai = mockAi({ tutor: tutorOut([c('I go', 'I went', { severity: 'important' })]), verify: () => { throw new Error('down'); } });
  const t = await tutorTurn({ structured: ai.structured, settings, strategy: 'verify', message: 'Yesterday I go to market' });
  assert.equal(t.reply, 'Nice! What did you buy?');
  assert.deepEqual(t.corrections, []);
  assert.equal(t.verified, false);
  assert.match(t.meta.checkError, /down/);
});

test('tutor turn, compare: both strategies from the same first call', async () => {
  const ai = mockAi({ tutor: tutorOut([c('I go', 'I went', { severity: 'important' })]), verify: { decisions: [{ index: 0, keep: false, reason: 'no' }] } });
  const t = await tutorTurn({ structured: ai.structured, settings, strategy: 'single', compare: true, message: 'Yesterday I go to market' });
  assert.equal(ai.calls.filter((x) => x.job === 'tutor').length, 1);
  assert.equal(t.compare.single.corrections.length, 1);
  assert.equal(t.compare.verify.corrections.length, 0);
  assert.ok(t.compare.verify.costInr > t.compare.single.costInr);
});
