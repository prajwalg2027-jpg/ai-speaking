// The conversation placement (server/placement/): every turn goes to the AI, which writes Sakhi's words and makes
// every judgement, the final level included. Covered: a whole talk, the request it sends (real turns that only
// grow), unexpected replies, help limits, the two things she must never give away, the AI ending the talk, the
// app's safety net when the AI fails or leaves the level out, and the switch between the classic test and this one.
// A stand-in for the AI gives each turn's answer.
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
  const structured = async ({ job, schema, messages, repair, effort, config }) => {
    asked.push({ job, user: messages.at(-1).content, messages, effort, model: config?.model }); // user: the note for the turn (the last message)
    const next = turns.shift();
    if (!next) throw new Error('the AI is down');
    if (next instanceof Error) throw next;
    return { data: schema.parse(repair ? repair(next) : next), provider: 'fake', model: 'fake-1', latencyMs: 5, usage: {}, costInr: 0.01, attempts: 1 };
  };
  return { structured, asked };
}
// What the AI answers on a turn (every field, as it must): the defaults are a plain "answered" turn.
const T = (o = {}) => ({ happened: 'answered', picture: null, reading: null, level: null, evidence: 'ok', tip: null, name: null, reply: 'Nice.', question: '', finish: false, final: null, ...o });
const FINAL = (level, o = {}) => ({ level, reason: `Sounds like level ${level}.`, doingWell: ['You answered every question in English.', 'You talked about your own life.'], practise: ['Next, we will make longer sentences.', 'Next, we will talk about yesterday.'], closing: 'You talked about your life in English. Next, we will make longer sentences.', ...o });
const say = (t) => t.say.map((l) => l.text).join(' | ');
// With seed 0 every talk has the same picture (a dog), lines to read and first open question.
const LINE2 = 'Yesterday I went to the market and bought some fresh vegetables.', LINE1 = 'I have a brother and a sister.';
function start(turns, opts = {}) {
  const ai = fakeAI(turns);
  const s = convo.getSession(convo.startSession({ seed: 0 }).sessionId);
  const go = (transcript, extra = {}) => convo.handleTurn(s, { event: 'answer', transcript, speechSec: 4, ...extra }, opts.trace || null, { structured: ai.structured, ...opts });
  const tap = (event) => convo.handleTurn(s, { event }, null, { structured: ai.structured, ...opts });
  return { s, ai, go, tap };
}
/** A talk taken to its first open question: the name, the picture named, the line read. turns: the AI's answers from there. */
async function toOpen(turns, opts = {}) {
  const x = start([
    T({ name: 'Asha', reply: 'Lovely to meet you, Asha!', question: "There's a picture on your screen. What is it called in English?" }),
    T({ picture: 'named', reply: 'Yes, a dog!', question: 'Now a line of English is on your screen. Could you read it out for me?' }),
    T({ reading: 'well', reply: 'Thank you, that was clear.', question: 'So, what did you do this morning?' }),
    ...turns,
  ], opts);
  await x.go('My name is Asha'); await x.go('It is a dog'); const t = await x.go(LINE2);
  x.ai.asked.length = 0;
  return { ...x, t };
}

test('the safety-net rule: how many open questions', () => {
  const next = (...levels) => level.nextStep(levels.map((l) => ({ level: l })));
  assert.deepEqual(next(), { done: false, target: 2 });
  assert.deepEqual(next(2), { done: true });
  assert.deepEqual(next(3), { done: false, target: 4 });
  assert.deepEqual(next(3, 3), { done: true });
  assert.deepEqual(next(3, 4), { done: false, target: 4 });
  assert.deepEqual(next(3, 4, 4), { done: true });
});

test('the safety-net rule: the level when the AI gives none', () => {
  const place = (picture, readAccuracy, ...r) => level.placementLevel({ picture, readAccuracy, ratings: r.map(([l, w]) => ({ level: l, englishWords: w })) });
  assert.equal(place(false, 0.4).level, 1, 'missed the picture and the reading');
  assert.equal(place(true, 0.2).level, 2, 'named the picture: level 2 at least');
  assert.equal(place(true, 0.9, [3, 30], [3, 30]).level, 3);
  assert.equal(place(true, 0.9, [3, 20], [4, 30], [4, 40]).level, 4);
  assert.equal(place(true, 0.9, [3, 10], [3, 9]).level, 2, 'too little English to place higher');
  assert.equal(level.qualifies({ picture: false, readAccuracy: 0.69 }), false);
});

test('every turn goes to the AI: hello, picture, reading, open questions, and the AI decides the level', async () => {
  const { s, ai, go } = start([
    T({ name: 'Asha', reply: 'Lovely to meet you, Asha!', question: "There's a picture on your screen. What is it called in English?" }),
    T({ picture: 'named', evidence: "said 'a dog'", reply: 'Yes, a dog!', question: 'Now a line of English is on your screen. Could you read it out for me?' }),
    T({ reading: 'well', reply: 'Thank you, that was clear.', question: 'So, what did you do this morning?' }),
    T({ level: 3, reply: 'Oh, you went to the gym before work!', tip: { said: 'I go to gym', better: 'I went to the gym' }, question: 'Do you think exercise should be taught in every school, and why?' }),
    T({ level: 4, reply: 'I like how you thought about both sides.', finish: true, final: FINAL(4, { reason: 'Explains opinions at length with few slips.', practise: ["Say 'I went to the gym' instead of 'I go to gym' for this morning.", 'Next, we will practise stronger words for opinions.'] }) }),
  ]);
  const fixed = new Set(placement.scriptedLines().map((l) => l.text));
  assert.ok(fixed.has(s.history[0].text), 'only the opening is a fixed line');

  let t = await go('My name is Asha');
  assert.equal(say(t), "Lovely to meet you, Asha! | There's a picture on your screen. What is it called in English?");
  assert.deepEqual([t.task.id, t.card.look, t.card.text, s.profile.name], ['picture', 'emoji', '🐶', 'Asha']);
  assert.match(ai.asked[0].user, /STEP: HELLO/);
  assert.match(ai.asked[0].user, /answered: move on: greet them, then lead into the picture/);

  t = await go('It is a dog');
  assert.match(ai.asked[1].user, /STEP: PICTURE/);
  assert.match(ai.asked[1].user, /The picture on their screen shows: dog\./);
  assert.match(ai.asked[1].user, /The app's check: "dog" is in their reply\./);
  assert.deepEqual([t.task.id, t.task.level, t.card.text, t.listen.language], ['read', 2, LINE2, 'en-IN']);
  assert.equal(s.picture.result, 'named');

  t = await go(LINE2);
  assert.match(ai.asked[2].user, /The line on their screen \(NEVER say it\): "Yesterday I went/);
  assert.match(ai.asked[2].user, /The app matched about 11 of its 11 words/);
  assert.match(ai.asked[2].user, /EARLIER IN THE TALK: Picture: named\./);
  assert.match(ai.asked[2].user, /decide whether they can go on\. If yes: ask your first open question/);
  assert.deepEqual([t.task.id, t.card, s.read.result], ['c1', null, 'well']);
  assert.equal(say(t), 'Thank you, that was clear. | So, what did you do this morning?');

  t = await go('I work in an office and today morning I go to gym before my office because I like to stay fit');
  assert.match(ai.asked[3].user, /STEP: OPEN QUESTION 1/);
  assert.match(ai.asked[3].user, /They spoke 2\d English words in this reply\./);
  assert.match(ai.asked[3].user, /either ask one more open question \(you may ask 2 more\) or finish/);
  assert.equal(t.task.id, 'c2');

  t = await go('I think it depends on the school because some children already play a lot, but in cities they sit all day so yes it should be taught properly');
  assert.match(ai.asked[4].user, /Earlier open answers: level 3 \(2\d English words\)\./);
  assert.equal(ai.asked.length, 5, 'one AI call for each of the five turns, and none more for the goodbye');
  assert.deepEqual([t.done.level, t.done.name, t.done.decidedBy, t.done.mode, t.task], [4, 'Very good', 'the AI', 'conversation', null]);
  assert.equal(t.done.reasons[0], 'Explains opinions at length with few slips.');
  assert.match(t.done.reasons[1], /Picture: named\. Reading: well \(the app matched 100% of the line\)\. Open answers: level 3, level 4\./);
  assert.match(say(t), /both sides\. \| Thank you! Your English is at level 4 of 4, Very good\. \| You talked about your life/);
  assert.match(t.done.practise[0], /I went to the gym/);
  assert.deepEqual(t.done.answers.map((a) => a.q), ['picture', 'read', 'c1', 'c2']);
  assert.deepEqual(t.done.answers[2].tip, { said: 'I go to gym', better: 'I went to the gym' });
  assert.deepEqual([s.answers[2].kind, s.answers[2].scores.level, s.answers[0].judged], ['open', 3, 'named']);

  // The request: fixed instructions, the talk as real turns, the learner's words, and a note for this turn.
  const sent = ai.asked[3].messages;
  assert.deepEqual([sent[0].role, sent[1].content, sent[2].role, sent.at(-2).role, sent.at(-1).role], ['system', '(The call begins.)', 'assistant', 'user', 'system']);
  assert.equal(sent[0].content, brain.BRAIN_SYSTEM);
  for (let i = 2; i < sent.length - 1; i++) assert.notEqual(sent[i].role, sent[i - 1].role, 'the roles alternate');
  // Each request repeats the one before (all but its note) and only adds to it: that part can be cached.
  for (let i = 1; i < ai.asked.length; i++) assert.ok(JSON.stringify(ai.asked[i].messages).startsWith(JSON.stringify(ai.asked[i - 1].messages.slice(0, -1)).slice(0, -1)), `request ${i + 1} only grows`);
  assert.ok(!brain.BRAIN_SYSTEM.includes('Asha'), 'nothing about one learner is in the fixed instructions');
});

test('something unexpected: a steer back once, then on; "I can\'t see it" skips the step without counting it', async () => {
  const { s, ai, go } = start([
    T({ happened: 'something_else', reply: 'Ha, I like pizza too!', question: 'And what should I call you?' }),
    T({ happened: 'something_else', reply: 'Okay!', question: "There's a picture on your screen. What is it called in English?" }),
    T({ happened: 'could_not', reply: "No problem at all, we'll leave that one.", question: 'There should be a line of text now. Could you read it out for me?' }),
    T({ happened: 'could_not', reply: "That's fine.", question: 'Tell me, where do you live?' }),
  ]);
  let t = await go('Pizza');
  assert.equal(say(t), 'Ha, I like pizza too! | And what should I call you?');
  assert.deepEqual([t.task.id, s.profile.name], ['hello', null], 'still on the hello, and no name taken');
  assert.match(ai.asked[0].user, /something_else: respond to it in a few words, then stay on this step/);
  t = await go('how long is this');
  assert.match(ai.asked[1].user, /something_else: respond to it in a few words\. move on: greet them, then lead into the picture/, 'one steer back per step');
  assert.equal(t.task.id, 'picture');
  t = await go('Sorry I cannot see any picture on my screen');
  assert.deepEqual([t.task.id, t.task.level, s.picture.result], ['read', 1, 'skipped']);
  assert.match(ai.asked[2].user, /could_not: don't count it against them\. move on: lead into the reading/);
  t = await go('The text is too small for me to read it properly');
  assert.deepEqual([t.task.id, s.read.result], ['c1', 'skipped'], 'the AI let them go on: they spoke real English');
  assert.match(ai.asked[3].user, /EARLIER IN THE TALK: Picture: skipped\./);
  assert.equal(say(t), "That's fine. | Tell me, where do you live?");
});

test('help: twice on a step, then she moves on; silence and unheard replies go to the AI too', async () => {
  const { s, ai, go, tap } = start([
    T({ happened: 'asked_for_help', reply: 'Of course.', question: 'What is your name? आपका नाम क्या है?' }),
    T({ happened: 'asked_for_help', reply: 'कोई बात नहीं।', question: 'आपका नाम क्या है?' }),
    T({ happened: 'asked_for_help', reply: "That's okay.", question: 'Look at the picture on your screen. What is it called in English?' }),
    T({ happened: 'answered', picture: 'not_named', reply: 'In English we call it a dog.', question: 'Now please read the line on your screen out loud.' }),
  ]);
  let t = await go('sorry?');
  assert.deepEqual([t.task.id, t.say.map((l) => l.lang).join()], ['hello', 'en-IN,en-IN,hi-IN'], 'English and Hindi sentences go to their own voices');
  t = await tap('no_speech');
  assert.match(ai.asked[1].user, /They said nothing\./);
  assert.equal(ai.asked[1].messages.at(-2).content, '(said nothing)', 'silence is kept as a turn');
  assert.equal(t.task.id, 'hello');
  t = await go('.');
  assert.match(ai.asked[2].user, /Their reply could not be heard\./);
  assert.match(ai.asked[2].user, /asked_for_help: they have had help already\. move on/);
  assert.equal(t.task.id, 'picture', 'the third time she moves on');
  t = await go('kutta');
  assert.deepEqual([s.picture.result, t.task.level, t.card.text], ['not_named', 1, LINE1], 'a very simple line for someone who missed the picture');
  assert.equal(ai.asked.length, 4);
});

test("she never gives away the picture's word or the line to read", async () => {
  const { s, go } = start([
    T({ name: 'Ravi', reply: 'Hello Ravi!', question: 'Do you see the dog on your screen? What is it called?' }),
    T({ picture: 'named', reply: 'Yes, a dog!', question: 'Please read this: Yesterday I went to the market and bought some fresh vegetables.' }),
    T({ reading: 'partly', reply: 'Thanks. Yesterday I went to the market, nice line!', question: 'What did you do today?' }),
  ]);
  let t = await go('Ravi');
  assert.equal(say(t), 'Hello Ravi! | Look at the picture. What is this called in English? | चित्र में क्या दिख रहा है, कृपया अंग्रेज़ी में बताइए।', 'the fixed question replaces one that says the word');
  t = await go('dog');
  assert.equal(say(t), 'Yes, a dog! | Please read this sentence out loud. | स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।', 'after they answer she may say the word, never the line');
  t = await go('Yesterday I went to market');
  assert.equal(say(t), 'What did you do today?', 'a reaction that reads the line out is dropped');
  assert.equal(s.read.result, 'partly');
});

test('the AI judges: "puppy" names the picture; it can end the talk after the reading, at level 1', async () => {
  let x = start([T({ name: 'Ravi', question: 'What is this called?' }), T({ picture: 'named', evidence: "'puppy' is right", reply: 'Yes!', question: 'Please read the line.' })]);
  await x.go('Ravi'); let t = await x.go('puppy');
  assert.match(x.ai.asked[1].user, /The app's check: "dog" is not in their reply\./);
  assert.deepEqual([x.s.picture.result, t.task.level, x.s.answers[0].judged], ['named', 2, 'named'], "the AI's judgement stands over the app's check");

  x = start([T({ question: 'What is this called?' }), T({ picture: 'not_named', reply: 'In English we call it a dog.', question: 'Please read the line.' }),
    T({ reading: 'not', reply: 'Thank you for trying.', finish: true, final: FINAL(1, { reason: 'Could not name the picture or read the line; no English sentences.', doingWell: ['You tried in English.', 'You listened carefully.'] }) })]);
  await x.go('नमस्ते'); await x.go('कुत्ता'); t = await x.go('आई');
  assert.deepEqual([t.done.level, t.done.decidedBy, x.s.ratings.length], [1, 'the AI', 0]);
  assert.match(say(t), /^Thank you for trying\. \| Thank you! Your English is at level 1 of 4, Beginner\. \| /);
  assert.equal(t.say.at(-1).lang, 'hi-IN', 'beginners hear the level in Hindi too');
  assert.match(t.done.reasons[1], /Picture: not named\. Reading: not/);
});

test('the last allowed question ends the talk; if the AI leaves the level out, the app\'s rule gives it', async () => {
  const { s, ai, go, t: first } = await toOpen([
    T({ level: 3, question: 'Why do you like your job?' }),
    T({ level: 4, question: 'What would you change about your city?' }),
    T({ level: 4, reply: 'Good point.', question: 'One more: what about schools?' }), // should have finished
    { doingWell: ['You explain your ideas well.', 'You give reasons for what you think.'], practise: ['Next, we will practise harder topics.', 'Next, we will work on precise words.'], closing: 'You explain your ideas well. Next, we will practise harder topics.' },
  ]);
  assert.equal(first.task.id, 'c1');
  const long = 'I work in a bank and every day I help the customers with their accounts and loans and after that I go home';
  await go(long); await go(long);
  const t = await go(long);
  assert.match(ai.asked[2].user, /answered: move on: this was the last question\. Finish now\./);
  assert.deepEqual([t.done.level, t.done.decidedBy], [4, "the app's rule"]);
  assert.match(t.done.reasons[0], /The AI gave no level, so the app's rule was used\. .*levels 3, 4, 4: level 4 was reached twice/);
  assert.equal(ai.asked[3].job, 'placementSummary', 'the feedback then comes from a second call');
  assert.match(t.done.doingWell[0], /explain your ideas well/);
  assert.equal(s.ratings.length, 3);
});

test('the AI fails: the talk carries on with the app\'s own checks and fixed lines, and the rule gives the level', async () => {
  const { s, go } = start([]);
  let t = await go('My name is Ravi');
  assert.equal(say(t), 'Nice to meet you, Ravi! | Look at the picture. What is this called in English? | चित्र में क्या दिख रहा है, कृपया अंग्रेज़ी में बताइए।');
  t = await go('table');
  assert.equal(t.say[0].text, "In English, this is called 'dog'.");
  t = await go('I the');
  assert.deepEqual([t.done.level, t.done.decidedBy, s.read.result], [1, "the app's rule", 'not']);
  assert.equal(t.done.doingWell.length, 2);

  // One failure in the middle of a good talk: only that turn uses the fixed lines.
  const x = await toOpen([new Error('timeout'), T({ level: 3, reply: 'I see.', finish: true, final: FINAL(3) })]);
  t = await x.go('I woke up early and made breakfast for my family then I went to the office by bus');
  assert.equal(t.say[0].text, 'Okay.');
  assert.deepEqual([x.s.ratings[0].level, t.task.id], [3, 'c2'], 'the level from the number of words; a question from the bank');
  t = await x.go('I think phones are good and bad both because people talk less now');
  assert.deepEqual([t.done.level, t.done.decidedBy], [3, 'the AI']);
});

test("a fix must be the learner's own words; questions in the reaction are dropped; older answer shapes are read", async () => {
  const { s, go } = await toOpen([T({ level: 3, reply: 'Oh nice! Do you cook daily? I love cooking too.', tip: { said: 'I cooking food', better: "I'm cooking food" }, question: 'What do you cook?' })]);
  const t = await go('I am make food for my family every day and I also clean the house');
  assert.equal(s.answers.at(-1).tip, null, 'they never said "I cooking food"');
  assert.equal(say(t), 'Oh nice! I love cooking too. | What do you cook?', 'one question at a time');
  assert.equal(brain.tipIsTheirs({ said: 'I am make food', better: 'I make food' }, 'I am make food for my family'), true);
  assert.deepEqual(brain.repairTurn({ answered: 'true', level: '3', reply: ' hi ', question: null, tip: 'none', name: 'null', picture: 'Not Named' }),
    { happened: 'answered', picture: 'not_named', reading: null, level: 3, evidence: '', tip: null, name: null, reply: 'hi', question: '', finish: false, final: null });
  assert.equal(brain.repairTurn({ reaction: 'hi', ask: 'x' }).reply, undefined, 'not a turn at all: left to fail');
});

// What a request sent, without the note for the turn (its last message): this part must only ever grow.
const talkOf = (asked) => asked.messages.slice(0, -1).map((m) => `${m.role}: ${m.content}`);
const grows = (earlier, later) => assert.deepEqual(talkOf(later).slice(0, talkOf(earlier).length), talkOf(earlier), 'the earlier request is repeated exactly, and only added to');

test('talking over her before her question: nothing in the talk is changed; the parts are judged as one answer', async () => {
  const { s, ai, go, tap } = await toOpen([
    T({ level: 2, reply: 'You made tea in the morning!', question: 'Who do you live with?' }),
    T({ level: 3, reply: 'A busy morning!', question: 'Why do you like mornings?' }),
    T({ level: 3, reply: 'That is a lot before lunch!', question: 'What do you like about mornings?' }),
  ]);
  await go('I made tea for my husband and my two children today');
  assert.equal(s.ratings.length, 1);
  const kept = s.history.map((h) => ({ ...h }));
  // They spoke again half a second into her first line: before her question.
  let t = await go('and then I walked to the market and bought vegetables for lunch', { interrupted: { index: 0, heardSec: 0.5 } });
  assert.deepEqual(s.history.slice(0, kept.length), kept, 'nothing already in the talk was changed or removed');
  grows(ai.asked[0], ai.asked[1]);
  // Her whole line, then the app's line saying where she was cut off, then only their new words.
  assert.deepEqual(ai.asked[1].messages.slice(-5, -1).map((m) => [m.role, m.content]), [
    ['user', 'I made tea for my husband and my two children today'],
    ['assistant', 'You made tea in the morning!\nWho do you live with?'],
    ['user', '[The app: Sakhi was cut off here] The learner started talking while she was still speaking. They heard only: "You". They did not hear: "made tea in the morning! Who do you live with?"'],
    ['user', 'and then I walked to the market and bought vegetables for lunch'],
  ]);
  const note = ai.asked[1].user;
  assert.match(note, /STEP: OPEN QUESTION 1/, 'judged against the question they were answering');
  assert.match(note, /THEY WERE STILL ANSWERING\.[^\n]*since you asked "So, what did you do this morning\?" is ONE answer/);
  assert.match(note, /They spoke 23 English words in the whole answer/);
  assert.deepEqual([s.ratings.length, s.ratings[0].level], [1, 3], 'still one answer, judged again as a whole');
  assert.equal(s.answers.at(-1).transcript, 'I made tea for my husband and my two children today and then I walked to the market and bought vegetables for lunch');
  assert.equal(t.task.id, 'c2');
  // And once more: a third part joins the same answer.
  t = await go('and I cooked dal and rice', { interrupted: { index: 0, heardSec: 0.2 } });
  grows(ai.asked[1], ai.asked[2]);
  assert.match(ai.asked[2].user, /They spoke 29 English words in the whole answer/);
  assert.deepEqual([s.ratings.length, t.task.id], [1, 'c2']);
  assert.equal(s.answers.at(-1).transcript.split(' ').length, 29);
  t = await tap('repeat');
  assert.deepEqual([say(t), t.say[0].pace, ai.asked.length], ['What do you like about mornings?', 0.85, 3]);
});

test('talking over her after hearing her question: her whole line stays, with a line saying what they heard', async () => {
  const { s, ai, go } = await toOpen([
    T({ level: 2, reply: 'You made tea in the morning!', question: 'Who do you live with at home?' }),
    T({ level: 2, reply: 'A full house!', question: 'What do you all do in the evening?' }),
    T({ level: 2, reply: 'That sounds lovely.', finish: true, final: FINAL(2) }),
  ]);
  await go('I made tea for my husband and my two children today');
  // Most of the way through her question (the second line).
  await go('I live with my husband and my children', { interrupted: { index: 1, heardSec: 60 } });
  assert.equal(s.history.filter((h) => h.who === 'app').length, 0, 'they heard all of it: nothing to add');
  await go('We watch television together', { interrupted: { index: 1, heardSec: 1.8 } });
  grows(ai.asked[0], ai.asked[1]); grows(ai.asked[1], ai.asked[2]);
  const sent = ai.asked[2].messages.map((m) => m.content);
  assert.ok(sent.includes('A full house!\nWhat do you all do in the evening?'), 'her line as she said it');
  const mark = sent.find((m) => m.startsWith(brain.CUT_OFF));
  assert.match(mark, /They heard only: "A full house! What do you all do[^"]*"\. They did not hear: "[^"]*evening\?"$/);
  assert.match(ai.asked[2].user, /STEP: OPEN QUESTION 3\n\nTHEY TALKED OVER YOU\. They heard only: "A full house! What do you all do[^"]*" \(your question included\)/);
  assert.equal(s.ratings.length, 3, 'three answers to three questions: nothing was joined');
  // The app's line is a message of its own, never run into the learner's words.
  assert.deepEqual(brain.talkTurns([{ who: 'sakhi', text: 'a' }, { who: 'sakhi', text: 'b' }, { who: 'app', text: 'x' }, { who: 'learner', text: 'c' }]).map((m) => [m.role, m.content]),
    [['user', '(The call begins.)'], ['assistant', 'a\nb'], ['user', 'x'], ['user', 'c']]);
});

test('only the answer just before can be carried on: help in between is not joined to an older answer', async () => {
  const { s, ai, go } = await toOpen([
    T({ level: 2, reply: 'You made tea!', question: 'Who do you live with?' }),
    T({ happened: 'asked_for_help', reply: 'No problem.', question: 'Who is in your family at home?' }),
    T({ level: 2, reply: 'A big family!', question: 'What do you do in the evening?' }),
  ]);
  await go('I made tea for my husband and my two children today');
  await go('sorry repeat please');
  await go('my husband and two children', { interrupted: { index: 0, heardSec: 0.3 } });
  assert.doesNotMatch(ai.asked[2].user, /STILL ANSWERING/);
  assert.match(ai.asked[2].user, /STEP: OPEN QUESTION 2\n\nTHEY TALKED OVER YOU\./);
  assert.equal(s.ratings.length, 2);
});

test('thinking: light on each turn, more for the final level; an early ending by the AI is evaluated again with more', async () => {
  const LUNA = { config: { provider: 'openai', model: 'gpt-6-luna', temperature: 0.6 } };
  assert.deepEqual([settings.get('placement').turnEffort, settings.get('placement').finalEffort], ['low', 'medium']);
  // The AI ends the talk after the first open answer: that turn is asked again, told to finish, with more thought.
  let x = await toOpen([
    T({ level: 2, reply: 'You made tea!', finish: true, final: FINAL(2, { reason: 'A quick look.' }) }),
    T({ level: 3, reply: 'Tea for everyone, how kind!', finish: true, final: FINAL(3, { reason: 'A careful look.' }) }),
  ], LUNA);
  let t = await x.go('I made tea for my husband and my two children today because they like it');
  assert.deepEqual(x.ai.asked.map((a) => a.effort), ['low', 'medium']);
  assert.match(x.ai.asked[1].user, /- answered: move on: you have heard enough to be sure of their level\. Finish now\./);
  assert.deepEqual(talkOf(x.ai.asked[1]), talkOf(x.ai.asked[0]), 'the same talk: only the note differs');
  assert.deepEqual([t.done.level, t.done.reasons[0], t.say[0].text], [3, 'A careful look.', 'Tea for everyone, how kind!'], 'the careful answer is the one used');

  // The last question allowed: the app knows it is the end, so it is one call, with more thought from the start.
  x = await toOpen([
    T({ level: 2, reply: 'Nice.', question: 'Who do you live with?' }),
    T({ level: 2, reply: 'Lovely.', question: 'What do you do in the evening?' }),
    T({ level: 2, reply: 'That sounds good.', finish: true, final: FINAL(2) }),
  ], LUNA);
  await x.go('I made tea today'); await x.go('I live with my family');
  t = await x.go('I watch television');
  assert.deepEqual([x.ai.asked.map((a) => a.effort), t.done.level], [['low', 'low', 'medium'], 2]);

  // The careful evaluation fails, or doesn't finish: the turn's own answer stands.
  x = await toOpen([T({ level: 2, reply: 'You made tea!', finish: true, final: FINAL(2) }), new Error('busy')], LUNA);
  t = await x.go('I made tea today');
  assert.deepEqual([x.ai.asked.length, t.done.level, t.done.decidedBy], [2, 2, 'the AI']);
  x = await toOpen([T({ level: 2, reply: 'You made tea!', finish: true, final: FINAL(2) }), T({ level: 2, reply: 'Hm.', question: 'And then?' })], LUNA);
  t = await x.go('I made tea today');
  assert.equal(t.done.level, 2);

  // The same thinking for both, or a provider that takes no thinking level: never a second call.
  await settings.set('placement', { ...settings.get('placement'), turnEffort: 'low', finalEffort: 'low' }, 'test');
  try {
    x = await toOpen([T({ level: 2, reply: 'You made tea!', finish: true, final: FINAL(2) })], LUNA);
    await x.go('I made tea today');
    assert.deepEqual(x.ai.asked.map((a) => a.effort), ['low']);
  } finally { await settings.reset('placement', 'test'); }
  x = await toOpen([T({ level: 2, reply: 'You made tea!', finish: true, final: FINAL(2) })]);
  t = await x.go('I made tea today');
  assert.deepEqual([x.ai.asked.length, t.done.level], [1, 2], 'Sarvam: one call');
  // Settings saved before these two existed still load, with the usual values.
  const old = { mode: 'conversation', brain: LUNA.config, summary: LUNA.config, maxQuestions: 2 };
  assert.deepEqual(settings.SECTIONS.placement.schema.parse(old), { ...old, turnEffort: 'low', finalEffort: 'medium' });
});

test('the switch: classic stays the default; conversation when chosen; each test keeps its kind', async () => {
  assert.equal(settings.get('placement').mode, 'classic');
  const classic = placement.startSession();
  assert.equal(placement.getSession(classic.sessionId).mode, undefined);
  await settings.set('placement', { ...settings.get('placement'), mode: 'conversation' }, 'test');
  try {
    const t = placement.startSession();
    assert.equal(placement.getSession(t.sessionId).mode, 'conversation');
    assert.ok(placement.getSession(classic.sessionId), 'the classic test in progress carries on');
    assert.ok(classic.task.id === 'q1_intro' && t.task.id === 'hello');
    assert.deepEqual(t.say.map((l) => l.lang), ['en-IN', 'hi-IN']);
  } finally { await settings.reset('placement', 'test'); }
  assert.equal(placement.startSession().task.id, 'q1_intro');
});
