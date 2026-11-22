// The conversation placement (server/placement/): the level rule, the fixed first steps (name, picture, reading),
// a whole talk for a strong speaker and for a beginner, help and moving on, the AI failing, fixes that must be the learner's own words, a talked-over answer,
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
    asked.push({ job, user: messages.at(-1).content, messages }); // user: the note for the turn (the last message)
    const next = turns.shift();
    if (!next) throw new Error('the AI is down');
    if (next instanceof Error) throw next;
    return { data: schema.parse(repair ? repair(next) : next), provider: 'fake', model: 'fake-1', latencyMs: 5, usage: {}, costInr: 0.01, attempts: 1 };
  };
  return { structured, asked };
}
const turn = (o) => ({ answered: true, level: 2, evidence: 'ok', tip: null, name: null, reply: 'Nice.', question: 'What do you do at work?', ...o });
const say = (t) => t.say.map((l) => l.text).join(' | ');
/**
 * A new talk, taken through the fixed steps (name, picture, reading) to the first open question.
 * turns: the AI's answers from there. picture/read: whether the learner gets them right.
 */
async function begin(turns, { picture = true, read = true } = {}) {
  const ai = fakeAI(turns);
  const s = convo.getSession(convo.startSession().sessionId);
  const go = (transcript) => convo.handleTurn(s, { event: 'answer', transcript, speechSec: 2 }, null, { structured: ai.structured });
  await go('My name is Asha');
  await go(picture ? s.q.v.expect[0][0] : 'table');
  const t = await go(read ? s.q.v.screen : 'um the the');
  return { s, ai, t };
}
const answer = (s, transcript, ai, extra = {}) => convo.handleTurn(s, { event: 'answer', transcript, speechSec: 6, ...extra }, null, { structured: ai.structured });

test('the level rule: how many open questions', () => {
  const next = (...levels) => level.nextStep(levels.map((l) => ({ level: l })));
  assert.deepEqual(next(), { done: false, target: 2 }, 'the first open question is an everyday one');
  assert.deepEqual(next(2), { done: true }, 'a level 1 or 2 answer ends the talk');
  assert.deepEqual(next(1), { done: true });
  assert.deepEqual(next(3), { done: false, target: 4 }, 'a stronger answer: one level up');
  assert.deepEqual(next(4), { done: false, target: 4 });
  assert.deepEqual(next(3, 3), { done: true }, 'the same level twice: finished');
  assert.deepEqual(next(3, 4), { done: false, target: 4 }, 'different: a third, at the higher');
  assert.deepEqual(next(3, 2), { done: false, target: 3 });
  assert.deepEqual(next(3, 4, 4), { done: true }, 'never more than three (the setting)');
  assert.deepEqual(level.nextStep([3, 2, 4].map((l) => ({ level: l })), 4), { done: false, target: 4 }, 'with four allowed: still climbing, one last question');
  assert.deepEqual(level.nextStep([{ level: 4 }], 1), { done: true });
});

test('the level rule: qualifying, and the highest level reached twice', () => {
  const place = (picture, readAccuracy, ...r) => level.placementLevel({ picture, readAccuracy, ratings: r.map(([l, w]) => ({ level: l, englishWords: w })) });
  assert.equal(place(false, 0.4).level, 1, 'missed the picture and the reading');
  assert.equal(place(false, null).level, 1);
  assert.match(place(false, 0.4).reasons[0], /Did not name the picture; read 40% of the line\./);
  assert.equal(place(true, 0.2).level, 2, 'named the picture: level 2 at least');
  assert.equal(place(false, 0.8, [1, 2]).level, 2, 'read the line: level 2 at least, whatever the open answer');
  assert.equal(place(true, 0.9, [2, 9]).level, 2);
  assert.equal(place(true, 0.9, [3, 30], [3, 30]).level, 3);
  assert.equal(place(true, 0.9, [3, 20], [4, 30], [4, 40]).level, 4);
  assert.equal(place(true, 0.9, [3, 20], [4, 30], [3, 25]).level, 3);
  assert.equal(place(true, 0.9, [3, 10], [3, 9]).level, 2, 'under 25 English words in the open answers: level 2 at most');
  assert.match(place(true, 0.9, [3, 30], [3, 30]).reasons[1], /levels 3, 3: level 3 was reached twice/);
  assert.equal(level.qualifies({ picture: false, readAccuracy: 0.7 }), true);
  assert.equal(level.qualifies({ picture: false, readAccuracy: 0.69 }), false);
  // One answer: a few words can't show a high level; mostly Hindi is level 1.
  assert.equal(level.clampLevel(4, { englishWordCount: 6, nonLatinRatio: 0 }), 2);
  assert.equal(level.clampLevel(3, { englishWordCount: 2, nonLatinRatio: 0 }), 1);
  assert.equal(level.clampLevel(3, { englishWordCount: 9, nonLatinRatio: 0.8 }), 1);
  assert.equal(level.clampLevel(3, { englishWordCount: 20, nonLatinRatio: 0 }), 3);
  assert.equal(level.missedLevel(3), 2);
});

test('name, picture, reading: fixed lines with cards on the screen, and no AI', async () => {
  const t0 = convo.startSession();
  const s = convo.getSession(t0.sessionId), ai = fakeAI([]);
  const go = (transcript) => convo.handleTurn(s, { event: 'answer', transcript, speechSec: 2 }, null, { structured: ai.structured });
  assert.deepEqual(t0.say.map((l) => [l.text.slice(0, 22), l.lang]), [['Hi, my name is Sakhi. ', 'en-IN'], ['नमस्ते, मेरा नाम सखी ह', 'hi-IN']]);
  assert.deepEqual([t0.task.id, t0.card], ['hello', null]);
  const fixed = new Set(placement.scriptedLines().map((l) => l.text));
  for (const l of t0.say) assert.ok(fixed.has(l.text), `generated ahead: ${l.text}`);

  let t = await go('My name is Ravi');
  assert.equal(s.profile.name, 'Ravi');
  assert.match(say(t), /^Nice to meet you, Ravi! \| Look at the picture\. What is this called in English\? \| /);
  assert.deepEqual([t.task.id, t.task.kind, t.card.look, t.card.text, t.cue.line], ['picture', 'vocab', 'emoji', s.q.v.screen, 1]);

  const word = s.q.v.expect[0][0];
  t = await go(`This is a ${word}`);
  assert.equal(say(t), "Yes, that's right! | Please read this sentence out loud. | स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।");
  assert.deepEqual([t.task.id, t.task.kind, t.task.level, t.card.look, t.listen.language], ['read', 'read', 2, 'sentence', 'en-IN']);
  assert.equal(t.card.text, s.q.v.screen, 'the line to read is on the screen');
  assert.ok(!say(t).includes(t.card.text), 'and she never says it');

  t = await go(s.q.v.screen.toLowerCase().replace(/[.,]/g, ''));
  assert.match(say(t), /^Thank you! \| /);
  assert.deepEqual([t.task.id, t.task.level, t.card, t.say.at(-1).lang], ['c1', 2, null, 'hi-IN'], 'qualified: an everyday open question, in both languages');
  assert.deepEqual([s.picture.hit, s.read.accuracy, s.ratings.length, ai.asked.length], [true, 1, 0, 0]);
  assert.deepEqual(s.answers.map((a) => [a.questionId, a.kind, a.skipped]), [['picture', 'vocab', false], ['read', 'read', false]]);
  for (const l of t.say) assert.ok(fixed.has(l.text), `generated ahead: ${l.text}`);

  // Names: only when clearly said.
  assert.deepEqual(['I am Priya', "I'm fine", 'Asha', 'yes', 'मेरा नाम रवि है', 'my name is not known'].map(convo.nameIn), ['Priya', null, 'Asha', null, null, null]);
});

test('a beginner who misses the picture and the reading: three easy steps, level 1, no AI, kind words', async () => {
  const s = convo.getSession(convo.startSession().sessionId), ai = fakeAI([]);
  const turn_ = (input) => convo.handleTurn(s, input, null, { structured: ai.structured });
  let t = await turn_({ event: 'no_speech' });
  assert.equal(say(t), 'What is your name? | आपका नाम क्या है?', 'silence: once more, slower');
  t = await turn_({ event: 'answer', transcript: 'सुनीता' });
  assert.match(say(t), /^Nice to meet you! \| Look at the picture/, 'no name is guessed from Hindi script');
  const word = s.q.v.expect[0][0];
  t = await turn_({ event: 'answer', transcript: 'sorry?' });
  assert.equal(t.task.id, 'picture', 'asked again, with the Hindi');
  assert.equal(t.say.at(-1).lang, 'hi-IN');
  t = await turn_({ event: 'answer', transcript: 'पता नहीं' });
  assert.equal(t.say[0].text, `No problem. In English, this is called '${word}'.`);
  assert.deepEqual([t.task.id, t.task.level], ['read', 1], 'a very simple line to read');
  t = await turn_({ event: 'answer', transcript: 'I the' });
  assert.equal(t.done.level, 1);
  assert.match(say(t), /^Thank you! \| Thank you! Your English is at level 1 of 4, Beginner\. \| /);
  assert.equal(t.say.at(-1).lang, 'hi-IN', 'the level in Hindi too');
  assert.match(t.done.reasons[0], /Did not name the picture; read \d+% of the line\./);
  assert.deepEqual([t.done.doingWell.length, t.done.practise.length, ai.asked.length], [2, 2, 0]);
  assert.deepEqual(s.answers.map((a) => [a.questionId, a.skipped, a.neededHindi]), [['picture', true, true], ['read', false, false]]);
});

test('named the picture but a short open answer: one open question, level 2, feedback from the AI', async () => {
  const { s, ai, t: asked } = await begin([
    turn({ level: 2, reply: 'Oh, you made tea!', question: '' }),
    { doingWell: ['You can say what you did in the morning.', "You know words like 'tea' and 'morning'."], practise: ['Next, we will make longer sentences.', 'Next, we will talk about yesterday.'], closing: 'You told me about your morning. Next, we will make longer sentences.' },
  ], { read: false });
  assert.equal(asked.task.id, 'c1', 'the picture alone qualifies');
  const t = await answer(s, 'I make tea in morning', ai);
  assert.match(ai.asked[0].user, /If their answer is level 2: finish\./);
  assert.match(ai.asked[0].user, /If their answer is level 3: ask a level 4 question\./);
  assert.match(ai.asked[0].user, /LEARNER'S NAME: Asha/);
  assert.match(ai.asked[1].user, /ALSO, EARLIER IN THE TALK: You know English words like/);
  assert.equal(t.done.level, 2);
  assert.match(t.done.reasons[1], /One open answer, at level 2\./);
  assert.match(t.done.doingWell[0], /what you did in the morning/);
});

test('a strong speaker: three open questions, level 4, feedback from their own words', async () => {
  const { s, ai } = await begin([
    turn({ level: 3, reply: "Oh, you went to the gym before work! That's a good habit.", tip: { said: 'I go to gym', better: 'I went to the gym' }, question: 'Do you think exercise should be taught in every school, and why?' }),
    turn({ level: 4, reply: 'I like how you thought about both sides.', question: 'If you could change one rule at your office, what would it be?' }),
    turn({ level: 4, reply: 'Flexible hours would help many people.', question: '' }),
    { doingWell: ["You explain your ideas clearly, like 'it depends on the school'.", 'You give reasons for what you think.'], practise: ["Say 'I went to the gym' instead of 'I go to gym' for this morning.", 'Next, we will practise stronger words for opinions.'], closing: "You explain your ideas with good reasons. Next, we'll practise talking about the past." },
  ]);
  let t = await answer(s, 'I work in an office and today morning I go to gym before my office because I like to stay fit', ai);
  assert.match(say(t), /you went to the gym.*\| Do you think exercise should be taught/s);
  assert.equal(t.task.level, 4, 'level 3 answer: the next question is one level up');
  assert.match(ai.asked[0].user, /CURRENT QUESTION \(level 2\)/);
  assert.match(ai.asked[0].user, /MEASURED FROM THEIR VOICE: 2\d English words/);
  assert.match(ai.asked[0].user, /If their answer is level 3: ask a level 4 question\./);
  t = await answer(s, 'I think it depends on the school because some children already play a lot, but in cities they sit all day so yes it should be taught properly', ai);
  assert.match(ai.asked[1].user, /LEARNER'S NAME: Asha/);
  assert.match(ai.asked[1].user, /If their answer is level 3: finish\./, 'two answers at level 3 would end it');
  // The request: fixed instructions, then the talk as real turns, the learner's words, and a note for this turn.
  const sent = ai.asked[0].messages;
  assert.deepEqual([sent[0].role, sent[1].role, sent[1].content, sent[2].role, sent.at(-2).role, sent.at(-1).role], ['system', 'user', '(The call begins.)', 'assistant', 'user', 'system']);
  assert.match(sent[2].content, /^Hi, my name is Sakhi\. What is your name\?\n/, "Sakhi's lines of one turn are one message");
  assert.ok(sent.some((m) => m.role === 'assistant' && m.content.startsWith('Nice to meet you, Asha!')), 'the AI sees the whole talk so far');
  assert.equal(sent.at(-2).content, 'I work in an office and today morning I go to gym before my office because I like to stay fit');
  for (let i = 2; i < sent.length - 1; i++) assert.notEqual(sent[i].role, sent[i - 1].role, 'the roles alternate');
  // The next request repeats this one (all but its note) and only adds to it: that part can be cached.
  const before = JSON.stringify(sent.slice(0, -1)).slice(0, -1), after = JSON.stringify(ai.asked[1].messages);
  assert.ok(after.startsWith(before), 'the talk only grows');
  assert.equal(t.task.level, 4);
  t = await answer(s, 'Honestly I would change the fixed timings, because people work better when they can choose their hours and it also reduces the traffic for everyone', ai);
  assert.equal(t.done.level, 4);
  assert.deepEqual([t.done.name, t.done.mode, t.listen, t.task], ['Very good', 'conversation', null, null]);
  assert.match(say(t), /Flexible hours.*\| Thank you! Your English is at level 4 of 4, Very good\. \| You explain your ideas/s);
  assert.equal(t.say.some((l) => l.lang === 'hi-IN'), false, 'no Hindi line for a strong speaker');
  assert.match(t.done.reasons[1], /levels 3, 4, 4: level 4 was reached twice/);
  assert.match(t.done.practise[0], /I went to the gym/);
  assert.deepEqual(t.done.answers.map((a) => a.q), ['picture', 'read', 'c1', 'c2', 'c3']);
  assert.deepEqual(t.done.answers[2].tip, { said: 'I go to gym', better: 'I went to the gym' });
  assert.match(ai.asked[3].user, /they said 'I go to gym'; better: 'I went to the gym'/, 'the fix reaches the closing feedback');
  // What the server saves for each answer.
  assert.deepEqual([s.answers[2].questionId, s.answers[2].kind, s.answers[2].variantLevel, s.answers[2].scores.level, s.answers[2].skipped], ['c1', 'open', 2, 3, false]);
  assert.equal(s.profile.name, 'Asha');
});

test('an open answer in Hindi counts as level 1 whatever the AI says; they keep level 2 for the picture and reading', async () => {
  const { s, ai } = await begin([turn({ level: 3, reply: 'अच्छा, आपने चाय बनाई!', question: 'What food do you like?' })]);
  const t = await answer(s, 'सुबह मैंने चाय बनाई और बच्चों को स्कूल भेजा', ai);
  assert.equal(s.ratings[0].level, 1, 'mostly not English');
  assert.equal(t.done.level, 2);
  assert.match(t.done.reasons.at(-1), /Level 2 at least, for the picture and the reading\./);
  assert.equal(t.say[0].lang, 'hi-IN', 'her Hindi reaction is spoken in the Hindi voice');
  assert.equal(t.say.at(-1).lang, 'hi-IN', 'the level in Hindi too');
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
  assert.match(ai.asked[2].user, /They said nothing \(silence\)/);
  assert.equal(ai.asked[2].messages.at(-2).content, '(said nothing)', 'silence is kept as a turn, so the talk still alternates');
  assert.equal(t.task.id, 'c2');
  t = await answer(s, 'I do not know', ai);
  assert.match(ai.asked[3].user, /If they did not answer: tell them kindly that it's fine, then finish\./, 'missing it would make level 3 twice');
  assert.deepEqual(s.ratings.map((r) => r.level), [3, 3], 'missed a level 4 question: counts as 3');
  assert.equal(s.answers.at(-1).skipped, true);
  assert.equal(t.done.level, 3, 'level 3 twice: finished');
});

test('repeat says the question again more slowly, without the AI; unheard open answers ask again, then move on', async () => {
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
  assert.equal(t.done.level, 2, 'missed the only open question: level 2 for the picture and reading');
  // Repeat on the reading step says the instruction again, never the line itself.
  const s2 = convo.getSession(convo.startSession().sessionId);
  await convo.handleTurn(s2, { event: 'answer', transcript: 'Ravi' }, null);
  await convo.handleTurn(s2, { event: 'skip' }, null);
  t = await convo.handleTurn(s2, { event: 'repeat' }, null);
  assert.equal(say(t), 'Please read this sentence out loud. | स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।');
});

test('the AI fails: she still answers, the level comes from the words, and a reviewed question is asked', async () => {
  const { s, ai } = await begin([]);
  let t = await answer(s, 'I woke up early and made breakfast for my family then I went to the office by bus', ai);
  assert.equal(t.say[0].text, 'Okay.');
  assert.equal(s.ratings[0].level, 3, '12 or more English words');
  assert.equal(t.task.level, 4);
  assert.ok(t.say.length >= 2 && t.say[1].text.length > 10, 'a question from the bank');
  t = await answer(s, 'I think phones are good and bad both because people talk less now', ai);
  assert.equal(t.done.level, 3, 'level 3 twice');
  assert.equal(t.done.doingWell.length, 2, 'plain feedback for the level');
  assert.match(t.done.doingWell[0], /You know English words like/);
});

test('a fix must be the learner\'s own words; questions in the reaction are dropped', async () => {
  const { s, ai } = await begin([turn({ level: 3, reply: 'Oh nice! Do you cook daily? I love cooking too.', tip: { said: 'I cooking food', better: "I'm cooking food" }, question: 'What do you cook?' })]);
  const t = await answer(s, 'I am make food for my family every day and I also clean the house', ai);
  assert.equal(s.answers.at(-1).tip, null, 'they never said "I cooking food"');
  assert.equal(say(t), 'Oh nice! I love cooking too. | What do you cook?', 'one question at a time');
  assert.equal(brain.tipIsTheirs({ said: 'I am make food', better: 'I make food' }, 'I am make food for my family'), true);
  assert.equal(brain.tipIsTheirs({ said: 'I make food', better: 'I make food.' }, 'I make food'), false, 'not a fix');
  assert.deepEqual(brain.repairTurn({ answered: 'true', level: '3', reply: ' hi ', question: null, tip: 'none', name: 'null' }),
    { answered: true, level: 3, evidence: '', tip: null, name: null, reply: 'hi', question: '' });
});

test('talking over her reaction: the two parts are one answer', async () => {
  const { s, ai } = await begin([
    turn({ level: 3, reply: 'You made tea in the morning!', question: 'Who do you live with?' }),
    turn({ level: 3, reply: 'A busy morning!', question: 'Why do you like mornings?' }),
  ]);
  await answer(s, 'I made tea for my husband and my two children today', ai);
  assert.equal(s.ratings.length, 1);
  // They spoke again half a second into her first line: before her question.
  const t = await answer(s, 'and then I walked to the market and bought vegetables for lunch', ai, { interrupted: { index: 0, heardSec: 0.5 } });
  assert.equal(s.ratings.length, 1, 'still one answer');
  assert.equal(s.answers.at(-1).transcript, 'I made tea for my husband and my two children today and then I walked to the market and bought vegetables for lunch');
  assert.match(ai.asked[1].user, /CURRENT QUESTION \(level 2\)/, 'rated against the question they were answering');
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
    assert.ok(classic.task.id === 'q1_intro' && t.task.id === 'hello');
  } finally { await settings.reset('placement', 'test'); }
  assert.equal(placement.startSession().task.id, 'q1_intro');
});
