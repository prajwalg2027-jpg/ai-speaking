// The conversation placement (server/placement/): the level rule, a whole talk for a strong speaker and for a
// beginner, help and moving on, the AI failing, fixes that must be the learner's own words, a talked-over answer,
// and the switch between the classic test and this one. A stand-in for the AI gives each turn's answer.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let convo, level, placement, settings, brain;
before(async () => {
  process.env.SARVAM_API_KEY = 'test-key';
  level = await import('../server/placement/level.js');
  convo = await import('../server/placement/conversation.js');
  placement = await import('../server/placement/index.js');
  brain = await import('../server/placement/brain.js');
  settings = await import('../server/settings.js');
});

/** A stand-in AI: answers each call from the list, in order; keeps what it was asked. */
function fakeAI(turns) {
  const asked = [];
  const structured = async ({ job, schema, messages, repair }) => {
    asked.push({ job, user: messages[1].content });
    const next = turns.shift();
    if (!next) throw new Error('the AI is down');
    if (next instanceof Error) throw next;
    return { data: schema.parse(repair ? repair(next) : next), provider: 'fake', model: 'fake-1', latencyMs: 5, usage: {}, costInr: 0.01, attempts: 1 };
  };
  return { structured, asked };
}
const turn = (o) => ({ answered: true, level: 2, evidence: 'ok', tip: null, name: null, reply: 'Nice.', question: 'What do you do at work?', ...o });
const say = (t) => t.say.map((l) => l.text).join(' | ');
const HELLO = { answered: true, level: 1, evidence: '', tip: null, name: null, reply: 'Nice to meet you!', question: 'Do you work or study?' };
/** A new talk, past the hello ("What's your name?", which isn't counted). turns: the AI's answers after it. */
async function begin(turns, hello = HELLO) {
  const ai = fakeAI([hello, ...turns]);
  const s = convo.getSession(convo.startSession().sessionId);
  const t = await convo.handleTurn(s, { event: 'answer', transcript: 'My name is Asha', speechSec: 2 }, null, { structured: ai.structured });
  ai.asked.length = 0;
  return { s, ai, t };
}
const answer = (s, transcript, ai, extra = {}) => convo.handleTurn(s, { event: 'answer', transcript, speechSec: 6, ...extra }, null, { structured: ai.structured });

test('the level rule: which question comes next', () => {
  const next = (...levels) => level.nextStep(levels.map((l) => ({ level: l })));
  assert.deepEqual(next(), { done: false, target: 1 }, 'an easy closed question first');
  assert.deepEqual(next(2), { done: false, target: 3 }, 'then one level up');
  assert.deepEqual(next(4), { done: false, target: 4 });
  assert.deepEqual(next(2, 2), { done: true }, 'the same level twice: finished after two questions');
  assert.deepEqual(next(3, 4), { done: false, target: 4 }, 'different: a third, at the higher');
  assert.deepEqual(next(3, 2), { done: false, target: 3 });
  assert.deepEqual(next(3, 4, 4), { done: true });
  assert.deepEqual(next(3, 2, 2), { done: true });
  assert.deepEqual(next(1, 2, 3), { done: false, target: 3 }, 'still climbing: one last question');
  assert.deepEqual(next(1, 2, 3, 3), { done: true }, 'never more than four');
  assert.deepEqual(level.nextStep([{ level: 1 }, { level: 3 }], 2), { done: true }, 'the admin can cap the questions');
});

test('the level rule: the highest level reached twice, held to what was measured', () => {
  const place = (...r) => level.placementLevel(r.map(([l, w]) => ({ level: l, englishWords: w }))).level;
  assert.equal(place([3, 20], [4, 30], [4, 40]), 4);
  assert.equal(place([3, 20], [4, 30], [3, 25]), 3);
  assert.equal(place([1, 2], [2, 6], [2, 9]), 2);
  assert.equal(place([2, 9], [2, 10]), 2);
  assert.equal(place([3, 10], [3, 9]), 2, 'under 25 English words in all: level 2 at most');
  assert.equal(place([2, 2], [2, 2]), 1, 'under 5 English words in all: level 1');
  assert.match(level.placementLevel([{ level: 3, englishWords: 30 }, { level: 3, englishWords: 30 }]).reasons[0], /level 3 was reached twice/);
  // One answer: a few words can't show a high level; mostly Hindi is level 1.
  assert.equal(level.clampLevel(4, { englishWordCount: 6, nonLatinRatio: 0 }), 2);
  assert.equal(level.clampLevel(3, { englishWordCount: 2, nonLatinRatio: 0 }), 1);
  assert.equal(level.clampLevel(3, { englishWordCount: 9, nonLatinRatio: 0.8 }), 1);
  assert.equal(level.clampLevel(3, { englishWordCount: 20, nonLatinRatio: 0 }), 3);
  assert.equal(level.missedLevel(3), 2);
});

test('she opens in English and Hindi and asks their name; the hello is not counted; then an easy closed question', async () => {
  const t = convo.startSession();
  assert.deepEqual(t.say.map((l) => l.lang), ['en-IN', 'hi-IN', 'en-IN', 'hi-IN']);
  assert.equal(t.cue.line, 2, 'the question starts on the third line');
  assert.deepEqual([t.card, t.task.id, t.say[2].text], [null, 'c0', "First, what's your name?"]);
  const fixed = new Set(placement.scriptedLines().map((l) => l.text));
  for (const l of t.say) assert.ok(fixed.has(l.text), `generated ahead: ${l.text}`);
  const s = convo.getSession(t.sessionId);
  const ai = fakeAI([{ ...HELLO, name: 'Ravi', reply: 'Nice to meet you, Ravi!' }]);
  const t2 = await convo.handleTurn(s, { event: 'answer', transcript: 'Ravi', speechSec: 1 }, null, { structured: ai.structured });
  assert.match(ai.asked[0].user, /YOU JUST ASKED THEIR NAME, ONLY TO SAY HELLO/);
  assert.match(ai.asked[0].user, /If their answer is level 4: ask a level 1 question\./, 'whatever they say, an easy question next');
  assert.equal(say(t2), 'Nice to meet you, Ravi! | Do you work or study?');
  assert.deepEqual([s.ratings.length, s.answers.length, t2.task.id, t2.task.level, s.profile.name], [0, 0, 'c1', 1, 'Ravi']);
});

test('a strong speaker: three questions, level 4, feedback from their own words', async () => {
  const { s, ai } = await begin([
    turn({ level: 3, reply: "Oh, you went to the gym before work! That's a good habit.", tip: { said: 'I go to gym', better: 'I went to the gym' }, question: 'Do you think exercise should be taught in every school, and why?' }),
    turn({ level: 4, reply: 'I like how you thought about both sides.', question: 'If you could change one rule at your office, what would it be?' }),
    turn({ level: 4, reply: 'Flexible hours would help many people.', question: '' }),
    { doingWell: ["You explain your ideas clearly, like 'it depends on the school'.", 'You give reasons for what you think.'], practise: ["Say 'I went to the gym' instead of 'I go to gym' for this morning.", 'Next, we will practise stronger words for opinions.'], closing: "You explain your ideas with good reasons. Next, we'll practise talking about the past." },
  ], { ...HELLO, name: 'Asha' });
  let t = await answer(s, 'I work in an office and today morning I go to gym before my office because I like to stay fit', ai);
  assert.match(say(t), /you went to the gym.*\| Do you think exercise should be taught/s);
  assert.equal(t.task.level, 4, 'level 3 answer: the next question is one level up');
  assert.match(ai.asked[0].user, /CURRENT QUESTION \(level 1\): "Do you work or study\?"/);
  assert.match(ai.asked[0].user, /MEASURED FROM THEIR VOICE: 2\d English words/);
  assert.match(ai.asked[0].user, /If their answer is level 3: ask a level 4 question\./);
  t = await answer(s, 'I think it depends on the school because some children already play a lot, but in cities they sit all day so yes it should be taught properly', ai);
  assert.match(ai.asked[1].user, /LEARNER'S NAME: Asha/);
  assert.match(ai.asked[1].user, /If their answer is level 3: finish\./, 'two answers at level 3 would end it');
  assert.equal(t.task.level, 4);
  t = await answer(s, 'Honestly I would change the fixed timings, because people work better when they can choose their hours and it also reduces the traffic for everyone', ai);
  assert.equal(t.done.level, 4);
  assert.deepEqual([t.done.name, t.done.mode, t.listen, t.task], ['Very good', 'conversation', null, null]);
  assert.match(say(t), /Flexible hours.*\| Thank you! Your English is at level 4 of 4, Very good\. \| You explain your ideas/s);
  assert.equal(t.say.some((l) => l.lang === 'hi-IN'), false, 'no Hindi line for a strong speaker');
  assert.match(t.done.reasons[0], /levels 3, 4, 4: level 4 was reached twice/);
  assert.match(t.done.practise[0], /I went to the gym/);
  assert.equal(t.done.answers.length, 3);
  assert.deepEqual(t.done.answers[0].tip, { said: 'I go to gym', better: 'I went to the gym' });
  assert.match(ai.asked[3].user, /they said 'I go to gym'; better: 'I went to the gym'/, 'the fix reaches the closing feedback');
  // What the server saves for each answer.
  assert.deepEqual([s.answers[0].questionId, s.answers[0].kind, s.answers[0].variantLevel, s.answers[0].scores.level, s.answers[0].skipped], ['c1', 'open', 1, 3, false]);
  assert.equal(s.profile.name, 'Asha');
});

test('a beginner: Hindi counts as level 1 whatever the AI says; two questions; the Hindi line at the end', async () => {
  const { s, ai } = await begin([
    turn({ level: 3, reply: 'अच्छा, आपने चाय बनाई!', question: 'What food do you like? आपको क्या खाना पसंद है? Say: I like...' }),
    turn({ level: 1, reply: 'Dal chawal, yum!', question: '' }),
    { doingWell: ['You tried in English.'], practise: [], closing: '' }, // unusable: plain lines are used
  ]);
  let t = await answer(s, 'सुबह मैंने चाय बनाई और बच्चों को स्कूल भेजा', ai);
  assert.equal(s.ratings[0].level, 1, 'mostly not English');
  assert.deepEqual(t.say.map((l) => l.lang), ['hi-IN', 'en-IN', 'hi-IN', 'en-IN'], 'English and Hindi sentences go to their own voices');
  assert.equal(t.task.level, 2);
  t = await answer(s, 'I like dal chawal', ai);
  assert.equal(t.done.level, 1);
  assert.equal(t.say.at(-1).lang, 'hi-IN', 'the level in Hindi too');
  assert.deepEqual(t.done.doingWell.length, 2);
  assert.match(t.done.practise[0], /everyday words/);
});

test('"sorry?" gets help and the same question; the third time she moves on, and it counts one level down', async () => {
  const { s, ai } = await begin([
    turn({ level: 3, question: 'Why did you choose your job?' }),
    turn({ answered: false, level: null, reply: 'No problem.', question: 'Why do you like your job? आपको अपना काम क्यों पसंद है?' }),
    turn({ answered: false, level: null, reply: 'कोई बात नहीं।', question: 'आपको अपना काम क्यों पसंद है? Try in English.' }),
    turn({ answered: false, level: null, reply: "That's okay, we'll leave it.", question: 'Tell me about your family.' }),
  ]);
  await answer(s, 'I work in a bank and every day I help the customers with their accounts and loans, and after that I go home and cook dinner for my parents', ai);
  let t = await answer(s, 'sorry I did not understand', ai);
  assert.equal(s.ratings.length, 1, 'not rated');
  assert.equal(t.task.id, 'c2', 'the same question');
  assert.match(ai.asked[1].user, /If they did not answer: help them, then ask the CURRENT QUESTION again/);
  t = await convo.handleTurn(s, { event: 'no_speech' }, null, { structured: ai.structured });
  assert.match(ai.asked[2].user, /THE LEARNER SAID NOTHING/);
  assert.equal(t.task.id, 'c2');
  t = await answer(s, 'I do not know', ai);
  assert.match(ai.asked[3].user, /If they did not answer: tell them kindly that it's fine, then finish\./, 'missing it would make level 3 twice');
  assert.deepEqual(s.ratings.map((r) => r.level), [3, 3], 'missed a level 4 question: counts as 3');
  assert.equal(s.answers[1].skipped, true);
  assert.equal(t.done.level, 3, 'level 3 twice: finished');
});

test('repeat says the question again more slowly, without the AI; unheard answers ask again, then move on', async () => {
  const { s, ai } = await begin([]);
  let t = await convo.handleTurn(s, { event: 'repeat' }, null, { structured: ai.structured });
  assert.deepEqual([t.say[0].text, t.say[0].pace], [s.q.text, 0.85]);
  t = await convo.handleTurn(s, { event: 'live_failed' }, null, { structured: ai.structured });
  assert.match(say(t), /couldn't hear that clearly/);
  await answer(s, '.', ai);
  t = await answer(s, '', ai);
  assert.match(say(t), /No problem at all/);
  assert.equal(s.ratings[0].missed, true);
  assert.equal(ai.asked.length, 0);
  assert.equal(t.task.id, 'c2');
});

test('the AI fails: she still answers, the level comes from the words, and a reviewed question is asked', async () => {
  const { s, ai, t: hello } = await begin([], new Error('timeout'));
  assert.equal(hello.say[0].text, 'Okay.', 'even the hello carries on');
  assert.equal(hello.task.id, 'c1');
  let t = await answer(s, 'I woke up early and made breakfast for my family then I went to the office by bus', ai);
  assert.equal(t.say[0].text, 'Okay.');
  assert.equal(s.ratings[0].level, 3, '12 or more English words');
  assert.equal(t.task.level, 4);
  assert.ok(t.say.length >= 2 && t.say[1].text.length > 10, 'a question from the bank');
  t = await answer(s, 'I think phones are good and bad both because people talk less now', ai);
  t = await answer(s, 'Yes because they need to learn it properly from the teacher in the school', ai);
  assert.equal(t.done.level, 3);
  assert.equal(t.done.doingWell.length, 2, 'plain feedback for the level');
});

test('a fix must be the learner\'s own words; questions in the reaction are dropped', async () => {
  const { s, ai } = await begin([turn({ level: 2, reply: 'Oh nice! Do you cook daily? I love cooking too.', tip: { said: 'I cooking food', better: "I'm cooking food" }, question: 'What do you cook?' })]);
  const t = await answer(s, 'I am make food for my family every day', ai);
  assert.equal(s.answers[0].tip, null, 'they never said "I cooking food"');
  assert.equal(say(t), 'Oh nice! I love cooking too. | What do you cook?', 'one question at a time');
  assert.equal(brain.tipIsTheirs({ said: 'I am make food', better: 'I make food' }, 'I am make food for my family'), true);
  assert.equal(brain.tipIsTheirs({ said: 'I make food', better: 'I make food.' }, 'I make food'), false, 'not a fix');
  assert.deepEqual(brain.repairTurn({ answered: 'true', level: '3', reply: ' hi ', question: null, tip: 'none', name: 'null' }),
    { answered: true, level: 3, evidence: '', tip: null, name: null, reply: 'hi', question: '' });
});

test('talking over her reaction: the two parts are one answer', async () => {
  const { s, ai } = await begin([
    turn({ level: 2, reply: 'You made tea in the morning!', question: 'Who do you live with?' }),
    turn({ level: 3, reply: 'A busy morning!', question: 'Why do you like mornings?' }),
  ]);
  await answer(s, 'I made tea', ai);
  assert.equal(s.ratings.length, 1);
  // They spoke again half a second into her first line: before her question.
  const t = await answer(s, 'and then I walked to the market and bought vegetables for lunch', ai, { interrupted: { index: 0, heardSec: 0.5 } });
  assert.equal(s.ratings.length, 1, 'still one answer');
  assert.equal(s.answers[0].transcript, 'I made tea and then I walked to the market and bought vegetables for lunch');
  assert.match(ai.asked[1].user, /CURRENT QUESTION \(level 1\)/, 'rated against the question they were answering');
  assert.equal(t.task.id, 'c2');
});

test('the switch: classic stays the default; conversation when chosen; each test keeps its kind', async () => {
  assert.equal(settings.get('placement').mode, 'classic');
  const classic = placement.startSession();
  assert.equal(placement.getSession(classic.sessionId).mode, undefined);
  await settings.set('placement', { ...settings.get('placement'), mode: 'conversation' }, 'test');
  try {
    const t = placement.startSession();
    const s = placement.getSession(t.sessionId);
    assert.equal(s.mode, 'conversation');
    assert.ok(placement.getSession(classic.sessionId), 'the classic test in progress carries on');
    assert.ok(classic.task.id === 'q1_intro' && t.task.id === 'c0');
  } finally { await settings.reset('placement', 'test'); }
  assert.equal(placement.startSession().task.id, 'q1_intro');
});
