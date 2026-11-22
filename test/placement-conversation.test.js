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
  const structured = async ({ job, schema, messages, repair, effort, config, onText, fast }) => {
    // What the AI was given: the app's latest STEP line, the learner's words, and what came after them (MEASURED).
    const lines = messages.slice(1), at = lines.findLastIndex((m) => m.role === 'user');
    asked.push({ job, messages, effort, fast, model: config?.model, streamed: !!onText, said: lines[at]?.content,
      step: lines.filter((m) => m.role === 'system' && /STEP: /.test(m.content)).at(-1)?.content, measured: lines.slice(at + 1).map((m) => m.content).join('\n') });
    const next = turns.shift();
    if (!next) throw new Error('the AI is down');
    if (next instanceof Error) throw next;
    // A provider that streams hands the answer over as it is written, a few letters at a time.
    if (onText) { const text = JSON.stringify(next); for (let i = 5; i < text.length + 5; i += 5) onText(text.slice(0, i)); }
    return { data: schema.parse(repair ? repair(next) : next), provider: 'fake', model: 'fake-1', latencyMs: 5, usage: {}, costInr: 0.01, attempts: 1 };
  };
  return { structured, asked };
}
// What the AI answers on a turn (every field, as it must): the defaults are a plain "answered" turn.
// Written here in full words, for reading; handed to the code in the short shape the AI is asked for (brain.toWire).
const FULL = (o = {}) => ({ happened: 'answered', picture: null, reading: null, level: null, evidence: 'ok', tip: null, name: null, reply: 'Nice.', question: '', finish: false, final: null, ...o });
const T = (o = {}) => brain.toWire(FULL(o));
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
  assert.equal(ai.asked[0].step, '[System] STEP: HELLO. You may stay for: help, something else.');
  assert.deepEqual([ai.asked[0].said, ai.asked[0].measured], ['My name is Asha', ''], 'a name: nothing to measure');

  t = await go('It is a dog');
  assert.equal(ai.asked[1].step, '[System] STEP: PICTURE. The picture on their screen shows: dog. You may stay for: help, something else.');
  assert.equal(ai.asked[1].measured, '', 'nothing is measured for the picture: the AI sees the word for itself');
  assert.deepEqual([t.task.id, t.task.level, t.card.text, t.listen.language], ['read', 2, LINE2, 'en-IN']);
  assert.equal(s.picture.result, 'named');

  t = await go(LINE2);
  assert.equal(ai.asked[2].step, `[System] RECORDED: picture named. STEP: READING. The line on their screen (NEVER say it): "${LINE2}" You may stay for: help, something else.`);
  assert.equal(ai.asked[2].measured, "[System] MEASURED: about 11 of the line's 11 words are in their reply.");
  assert.deepEqual([t.task.id, t.card, s.read.result], ['c1', null, 'well']);
  assert.equal(say(t), 'Thank you, that was clear. | So, what did you do this morning?');

  t = await go('I work in an office and today morning I go to gym before my office because I like to stay fit');
  assert.equal(ai.asked[3].step, '[System] RECORDED: reading well. STEP: OPEN QUESTION 1 of 3. You may stay for: help, something else.');
  assert.match(ai.asked[3].measured, /^\[System\] MEASURED: 2\d English words\.$/);
  assert.equal(t.task.id, 'c2');

  t = await go('I think it depends on the school because some children already play a lot, but in cities they sit all day so yes it should be taught properly');
  assert.match(ai.asked[4].step, /^\[System\] RECORDED: open answer 1: level 3 \(2\d English words\)\. STEP: OPEN QUESTION 2 of 3\. You may stay for: help, something else\.$/);
  assert.equal(ai.asked.length, 5, 'one AI call for each of the five turns, and none more for the goodbye');
  assert.deepEqual([t.done.level, t.done.name, t.done.decidedBy, t.done.mode, t.task], [4, 'Very good', 'the AI', 'conversation', null]);
  assert.equal(t.done.reasons[0], 'Explains opinions at length with few slips.');
  assert.match(t.done.reasons[1], /Picture: named\. Reading: well \(the app matched 100% of the line\)\. Open answers: level 3, level 4\./);
  assert.match(say(t), /both sides\. \| Thank you! Your English is at level 4 of 4, Very good\. \| You talked about your life/);
  assert.match(t.done.practise[0], /I went to the gym/);
  assert.deepEqual(t.done.answers.map((a) => a.q), ['picture', 'read', 'c1', 'c2']);
  assert.deepEqual(t.done.answers[2].tip, { said: 'I go to gym', better: 'I went to the gym' });
  assert.deepEqual([s.answers[2].kind, s.answers[2].scores.level, s.answers[0].judged], ['open', 3, 'named']);

  // The request: the fixed instructions, then the talk: her turns, the app's lines, the learner's words.
  const sent = ai.asked[3].messages;
  assert.equal(sent[0].content, brain.BRAIN_SYSTEM);
  assert.deepEqual(sent.slice(1).map((m) => m.role), ['user', 'assistant', 'system', 'user', 'assistant', 'system', 'user', 'assistant', 'system', 'user', 'system', 'assistant', 'system', 'user', 'system']);
  assert.ok(sent.slice(1).every((m) => m.role !== 'system' || m.content.startsWith('[System] ')), "the app's lines are marked");
  // Nothing is said for one request only: each request is the one before it, whole, plus what is new. So all of
  // the earlier request can be reused from cache.
  for (let i = 1; i < ai.asked.length; i++) assert.deepEqual(ai.asked[i].messages.slice(0, ai.asked[i - 1].messages.length), ai.asked[i - 1].messages, `request ${i + 1} is request ${i}, whole, and more`);
  assert.deepEqual(ai.asked[4].messages.slice(ai.asked[3].messages.length).map((m) => m.role), ['assistant', 'system', 'user', 'system'],
    "new in a request: her last words, the app's STEP line, their reply, the app's MEASURED line");
  // The rules themselves are in the fixed instructions, the same for every learner and every turn.
  for (const rule of [/WHAT TO DO NEXT/, /- "h" \(asked_for_help\): stay on the step, if the latest STEP line says you may stay for help/, /- from HELLO: the picture\./, /- from READING: decide whether they can go on/, /If the STEP line says it is the last question, finish\./])
    assert.match(brain.BRAIN_SYSTEM, rule);
  assert.ok(!brain.BRAIN_SYSTEM.includes('Asha'), 'nothing about one learner is in the fixed instructions');
});

test('the fixed instructions: her reply ("r") and her question ("q") are one spoken turn, and the reply asks nothing', async () => {
  const told = brain.BRAIN_SYSTEM;
  assert.match(told, /"r" and "q" are spoken one straight after the other, as a single turn/);
  assert.match(told, /"q" picks up from where "r" ended\. It does not start afresh, does not greet or react again, and does not repeat anything "r" already said/);
  assert.match(told, /- "r": [^\n]*It must contain no question: not one question mark\. Everything you ask goes in "q"\./);
  // The app's net for a model that asks in its reply anyway: the question there is left out, moving on or staying.
  const { go } = await toOpen([
    T({ level: 2, reply: 'You made tea! Do you like tea?', question: 'Who do you live with?' }),
    T({ happened: 'asked_for_help', reply: 'No problem. Who is at home with you?', question: 'Who lives in your home?' }),
  ]);
  assert.equal(say(await go('I made tea for my family today')), 'You made tea! | Who do you live with?');
  assert.equal(say(await go('sorry repeat please')), 'No problem. | Who lives in your home?');
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
  assert.match(ai.asked[0].step, /You may stay for: help, something else\.$/);
  t = await go('how long is this');
  assert.equal(ai.asked[1].step, '[System] STEP: HELLO, still. You may stay for: help.', 'one steer back per step');
  assert.equal(t.task.id, 'picture');
  t = await go('Sorry I cannot see any picture on my screen');
  assert.deepEqual([t.task.id, t.task.level, s.picture.result], ['read', 1, 'skipped']);
  assert.equal(ai.asked[2].step, '[System] STEP: PICTURE. The picture on their screen shows: dog. You may stay for: help, something else.');
  t = await go('The text is too small for me to read it properly');
  assert.deepEqual([t.task.id, s.read.result], ['c1', 'skipped'], 'the AI let them go on: they spoke real English');
  assert.match(ai.asked[3].step, /^\[System\] RECORDED: picture skipped\. STEP: READING\./);
  for (let i = 1; i < ai.asked.length; i++) grows(ai.asked[i - 1], ai.asked[i]);
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
  assert.deepEqual([ai.asked[1].said, ai.asked[1].messages.at(-1).content], ['(said nothing)', '(said nothing)'], 'silence is kept as a turn, and is the last thing sent');
  assert.equal(ai.asked[1].step, '[System] STEP: HELLO, still. You may stay for: help, something else.');
  assert.equal(t.task.id, 'hello');
  t = await go('.');
  assert.equal(ai.asked[2].said, '(could not be heard)');
  assert.equal(ai.asked[2].step, '[System] STEP: HELLO, still. You may stay for: something else.', 'they have had help twice');
  assert.equal(t.task.id, 'picture', 'the third time she moves on');
  t = await go('kutta');
  assert.deepEqual([s.picture.result, t.task.level, t.card.text], ['not_named', 1, LINE1], 'a very simple line for someone who missed the picture');
  assert.equal(ai.asked.length, 4);
  // Silence, an unheard reply, help: whatever happened, each request is the one before it, whole, and more.
  for (let i = 1; i < ai.asked.length; i++) grows(ai.asked[i - 1], ai.asked[i]);
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
  assert.deepEqual([x.ai.asked[1].said, x.ai.asked[1].measured], ['puppy', ''], "the AI is given their word and the picture, not the server's own check");
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
  assert.match(ai.asked[2].step, /STEP: OPEN QUESTION 3 of 3\. It is the last question: when you move on from it, finish\. You may stay for: help, something else\.$/);
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
  assert.equal(t.say[0].text, 'Got it.');
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

// What a request sent: it must only ever grow.
const talkOf = (asked) => asked.messages.map((m) => `${m.role}: ${m.content}`);
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
  // Her whole turn; the app's lines saying where she was cut off and that they were still answering; then only
  // their new words, and the count for the whole answer.
  assert.deepEqual(ai.asked[1].messages.slice(ai.asked[0].messages.length).map((m) => [m.role, m.content]), [
    ['assistant', 'You made tea in the morning!\nWho do you live with?'],
    ['system', '[System] RECORDED: open answer 1: level 2 (11 English words). STEP: OPEN QUESTION 2 of 3. You may stay for: help, something else.'],
    ['system', '[System] CUT OFF: The learner started talking while you were still speaking. They heard only: "You". They did not hear: "made tea in the morning! Who do you live with?" They were still answering your earlier question, "So, what did you do this morning?": everything they have said since it is ONE answer, in parts. This replaces what was recorded for its first part.'],
    ['system', '[System] STEP: OPEN QUESTION 1 of 3. You may stay for: help, something else.'],
    ['user', 'and then I walked to the market and bought vegetables for lunch'],
    ['system', '[System] MEASURED: 23 English words in the whole answer, all its parts together.'],
  ]);
  assert.match(brain.BRAIN_SYSTEM, /If the line says they were still answering an earlier question, judge everything they have said since that question as ONE answer/);
  assert.deepEqual([s.ratings.length, s.ratings[0].level], [1, 3], 'still one answer, judged again as a whole');
  assert.equal(s.answers.at(-1).transcript, 'I made tea for my husband and my two children today and then I walked to the market and bought vegetables for lunch');
  assert.equal(t.task.id, 'c2');
  // And once more: a third part joins the same answer.
  t = await go('and I cooked dal and rice', { interrupted: { index: 0, heardSec: 0.2 } });
  grows(ai.asked[1], ai.asked[2]);
  assert.equal(ai.asked[2].measured, '[System] MEASURED: 29 English words in the whole answer, all its parts together.');
  assert.match(ai.asked[2].messages.at(-5).content, /^\[System\] RECORDED: open answer 1 \(all its parts\): level 3 \(23 English words\)\. STEP: OPEN QUESTION 2 of 3\./);
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
  assert.equal(s.history.filter((h) => /CUT OFF/.test(h.text)).length, 0, 'they heard all of it: nothing to add');
  await go('We watch television together', { interrupted: { index: 1, heardSec: 1.8 } });
  grows(ai.asked[0], ai.asked[1]); grows(ai.asked[1], ai.asked[2]);
  const sent = ai.asked[2].messages.map((m) => m.content);
  assert.ok(sent.includes('A full house!\nWhat do you all do in the evening?'), 'her line as she said it');
  const mark = sent.find((m) => m.startsWith('[System] CUT OFF:'));
  assert.match(mark, /They heard only: "A full house! What do you all do[^"]*"\. They did not hear: "[^"]*evening\?"$/);
  assert.match(ai.asked[2].step, /STEP: OPEN QUESTION 3 of 3\./, 'the step is the one she asked about: nothing was joined');
  assert.equal(s.ratings.length, 3, 'three answers to three questions: nothing was joined');
  // The app's line is a message of its own, never run into the learner's words.
  assert.deepEqual(brain.talkTurns([{ who: 'sakhi', text: 'a' }, { who: 'sakhi', text: 'b' }, { who: 'app', text: 'x' }, { who: 'learner', text: 'c' }]).map((m) => [m.role, m.content]),
    [['user', '(The call begins.)'], ['assistant', 'a\nb'], ['system', 'x'], ['user', 'c']]);
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
  const cutOff = ai.asked[2].messages.map((m) => m.content).find((c) => c.startsWith('[System] CUT OFF:'));
  assert.doesNotMatch(cutOff, /still answering/);
  assert.equal(ai.asked[2].step, '[System] STEP: OPEN QUESTION 2 of 3, still. You may stay for: help, something else.');
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
  assert.equal(x.ai.asked[1].messages.at(-1).content, '[System] You have heard enough to be sure of their level. Finish now: leave out "q" and add "f".');
  assert.deepEqual(talkOf(x.ai.asked[1]).slice(0, -1), talkOf(x.ai.asked[0]), 'the same request, with that one line more');
  assert.deepEqual([t.done.level, t.done.reasons[0], t.say[0].text], [3, 'A careful look.', 'You made tea!'], 'the careful level and feedback; her reply stays as first given');

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
  // Speed: OpenAI's Fast mode is asked for unless the settings, or the talk itself (the model comparison), say standard.
  assert.equal(settings.get('placement').speed, 'fast');
  x = await toOpen([T({ level: 2, question: 'And then?' })], LUNA);
  await x.go('I made tea today');
  assert.equal(x.ai.asked[0].fast, true);
  x = await toOpen([T({ level: 2, question: 'And then?' })], { ...LUNA, speed: 'standard' });
  await x.go('I made tea today');
  assert.equal(x.ai.asked[0].fast, false);
  // A talk can be given its own thinking levels (the model comparison), whatever the settings say.
  x = await toOpen([T({ level: 2, reply: 'You made tea!', finish: true, final: FINAL(2) }), T({ level: 2, reply: 'Tea!', finish: true, final: FINAL(3) })], { ...LUNA, efforts: { turn: 'none', final: 'xhigh' } });
  t = await x.go('I made tea today');
  assert.deepEqual([x.ai.asked.map((a) => a.effort), t.done.level], [['none', 'xhigh'], 3]);
  // Settings saved before these two existed still load, with the usual values.
  const old = { mode: 'conversation', brain: LUNA.config, summary: LUNA.config, maxQuestions: 2 };
  assert.deepEqual(settings.SECTIONS.placement.schema.parse(old), { ...old, speed: 'fast', turnEffort: 'low', finalEffort: 'medium' });
});

test('a model that streams: her reply is known, and its voice can start, before the rest of the answer is written', async () => {
  const early = [];
  const LUNA = { config: { provider: 'openai', model: 'gpt-6-luna', temperature: 0.6 }, onReply: (lines) => early.push(lines.map((l) => l.text)) };
  const x = start([
    T({ name: 'Asha', reply: 'Lovely to meet you, Asha!', question: "There's a picture on your screen. What is it called in English?" }),
    T({ happened: 'asked_for_help', reply: 'No problem, take your time. It is a dog!', question: 'What do you see in the picture?' }),
    T({ happened: 'asked_for_help', reply: 'No problem, take your time.', question: 'What do you see in the picture?' }),
    T({ picture: 'named', reply: 'Yes, a dog! Do you have one?', question: 'Now please read the line on your screen.' }),
    T({ reading: 'well', reply: 'Thank you, Asha.', question: 'What did you do this morning?' }),
    T({ level: 2, reply: 'आपने चाय बनाई! You made tea.', finish: true, final: FINAL(2) }),
  ], LUNA);
  const reaction = (t) => t.say.slice(0, t.cue.line).map((l) => l.text);
  let t = await x.go('My name is Asha');
  assert.deepEqual(early, [['Lovely to meet you, Asha!']], 'the name they said is kept, as in the turn itself');
  assert.deepEqual(reaction(t), early[0]);
  // Staying on the picture: a reply that gives the word away is not started (it will be dropped) ...
  t = await x.go('sorry repeat');
  assert.equal(early.length, 1);
  assert.doesNotMatch(say(t), /dog/);
  // ... one that doesn't, is.
  t = await x.go('sorry what');
  assert.deepEqual([early.length, early[1], reaction(t)], [2, ['No problem, take your time.'], ['No problem, take your time.']]);
  // Moving on: once they have answered she may say the word; a question in her reaction is left out, as in the turn.
  t = await x.go('It is a dog');
  assert.deepEqual([early[2], reaction(t)], [['Yes, a dog!'], ['Yes, a dog!']]);
  t = await x.go(LINE2);
  assert.deepEqual(early[3], ['Thank you, Asha.']);
  // The last turn: her reply is on its way while the level and feedback are still being written. Hindi and
  // English go to their own voices.
  t = await x.go('I made tea for my family');
  assert.deepEqual(early[4], ['आपने चाय बनाई!', 'You made tea.']);
  assert.deepEqual(t.say.slice(0, 2).map((l) => l.text), early[4]);
  // Every turn is streamed. (The seventh call is the level and feedback asked again with more thought: its
  // words aren't spoken, so there is nothing to start early.)
  assert.deepEqual(x.ai.asked.map((a) => a.streamed), [true, true, true, true, true, true, false]);

  // A provider that doesn't stream is asked the plain way.
  const plain = start([T({ name: 'Asha', reply: 'Hello, Asha!', question: 'What is this picture called in English?' })], { onReply: () => assert.fail('not streamed') });
  await plain.go('My name is Asha');
  assert.equal(plain.ai.asked[0].streamed, false);
});

test('a reply that has gone to the app is what she says, whatever the rest of the answer turns out to be', async () => {
  const LUNA = { provider: 'openai', model: 'gpt-6-luna', temperature: 0.6 };
  const sent = [];
  // A stand-in that streams one answer and then hands back another (as when the first had to be asked for again).
  const twoMinds = (streamed, final) => async ({ schema, repair, onText }) => {
    onText?.(JSON.stringify(streamed));
    if (final instanceof Error) throw final;
    return { data: schema.parse(repair(final)), provider: 'openai', model: 'gpt-6-luna', latencyMs: 5, usage: {}, costInr: 0.01, attempts: 2 };
  };
  const turn = (s, transcript, structured, commit) => convo.handleTurn(s, { event: 'answer', transcript, speechSec: 3 }, null, { config: LUNA, structured, commit });
  const first = T({ name: 'Asha', reply: 'Lovely to meet you, Asha!', question: 'What is this picture called in English?' });
  const second = T({ name: 'Asha', reply: 'Hello there, Asha.', question: 'There is a picture on your screen. What is it called in English?' });

  // Sent to the app: her reaction is the one that was sent; her question is the final answer's.
  let s = convo.getSession(convo.startSession({ seed: 0 }).sessionId);
  let t = await turn(s, 'My name is Asha', twoMinds(first, second), (lines) => { sent.push(lines.map((l) => l.text)); return true; });
  assert.deepEqual(sent, [['Lovely to meet you, Asha!']]);
  assert.equal(say(t), 'Lovely to meet you, Asha! | There is a picture on your screen. What is it called in English?');
  assert.ok(s.history.some((h) => h.who === 'sakhi' && h.text === 'Lovely to meet you, Asha!') && !s.history.some((h) => /Hello there/.test(h.text)), 'and that is what the talk keeps');
  // The app asks for her reaction's voice before the turn is finished: it must count as a line of hers by then.
  const guard = await import('../server/guard.js'), fixed = new Set(['Okay.']);
  const mid = convo.getSession(convo.startSession({ seed: 0 }).sessionId);
  let allowedMidTurn = null;
  await turn(mid, 'My name is Asha', twoMinds(first, second), (lines) => { allowedMidTurn = [guard.isHerLine(lines[0].text, mid, fixed), mid.history.some((h) => h.text === lines[0].text)]; return true; });
  assert.deepEqual(allowedMidTurn, [true, false], 'allowed while the turn is still being worked out, though not yet in the talk');
  assert.deepEqual([guard.isHerLine('Lovely to meet you, Asha!', mid, fixed), guard.isHerLine('to meet you, Asha!', mid, fixed), guard.isHerLine('Something she never said.', mid, fixed), guard.isHerLine('Okay.', null, fixed)], [true, true, false, true]);
  // Not sent (an app that takes the whole turn at once): the final answer's reaction, as before.
  s = convo.getSession(convo.startSession({ seed: 0 }).sessionId);
  t = await turn(s, 'My name is Asha', twoMinds(first, second), null);
  assert.equal(say(t), 'Hello there, Asha. | There is a picture on your screen. What is it called in English?');
  // The AI fails after her reaction went out: she has said it, and goes on with the fixed line for the next step.
  s = convo.getSession(convo.startSession({ seed: 0 }).sessionId);
  t = await turn(s, 'My name is Asha', twoMinds(first, new Error('cut off')), () => true);
  assert.equal(t.say[0].text, 'Lovely to meet you, Asha!');
  assert.deepEqual([t.task.id, t.say.length > 1, t.cue.line], ['picture', true, 1], 'then the picture, in the fixed words');
});

test('reading an answer while it is still being written: the fields up to the reply', () => {
  const whole = JSON.stringify(T({ level: 3, evidence: 'They said "r": yes, and {more}', tip: { said: 'I go', better: 'I went' }, name: 'Asha', reply: 'Oh, you went to the "big" market!', question: 'Why?' }));
  const upTo = (n) => brain.fieldsUpTo(whole.slice(0, n), 'r');
  const end = whole.indexOf('market!"') + 'market!"'.length; // just past the reply's closing quote
  assert.equal(upTo(end - 1), null, 'not until the reply is finished');
  assert.deepEqual(upTo(end), { h: 'a', lv: 3, ev: 'They said "r": yes, and {more}', tip: ['I go', 'I went'], n: 'Asha', r: 'Oh, you went to the "big" market!' });
  assert.deepEqual(upTo(whole.length), upTo(end), 'the same however much more has arrived');
  assert.equal(brain.fieldsUpTo('', 'r'), null);
  assert.equal(brain.fieldsUpTo('Sorry, I cannot', 'r'), null);
  assert.equal(brain.fieldsUpTo('{"f": {"r": "inside"}, "r', 'r'), null, 'only the answer\'s own field counts');
});

test("the AI's answer is as short as it can be: short keys, letters for values, nothing written that does not apply", async () => {
  // What it is asked for.
  const told = brain.BRAIN_SYSTEM;
  assert.match(told, /leave out every key that does not apply: never write null, an empty text or an empty list/);
  for (const key of ['h', 'p', 'rd', 'lv', 'ev', 'tip', 'n', 'r', 'q', 'f']) assert.ok(told.includes(`- "${key}": `), `the instructions explain "${key}"`);
  assert.doesNotMatch(told, /"happened"|"picture"|"reading"|"evidence"|"reply"|"question"|"finish"|"final"|doingWell|practise:/, 'no long names left to copy');
  // The short answer read back into the full shape the code uses.
  const hello = { h: 'a', n: 'Prajwal', r: 'Nice to meet you, Prajwal.', q: "There's a picture on your screen. What is it called in English?" };
  assert.deepEqual(brain.repairTurn(hello), FULL({ evidence: '', name: 'Prajwal', reply: hello.r, question: hello.q }));
  assert.deepEqual(brain.toWire(brain.repairTurn(hello)), hello, 'and back: nothing is added');
  const last = { h: 'a', lv: 3, ev: "Joined ideas: 'because it is near'", tip: ['I go', 'I went'], r: 'Oh, you went there!', f: { lv: 3, why: 'Connected sentences.', good: ['You gave a reason.', 'You spoke in full sentences.'], next: ["Say 'I went' for yesterday.", 'Next, we will tell a story.'], bye: 'You gave a clear reason. Next, we will tell stories.' } };
  assert.deepEqual(brain.repairTurn(last), FULL({ level: 3, evidence: last.ev, tip: { said: 'I go', better: 'I went' }, reply: 'Oh, you went there!', finish: true,
    final: { level: 3, reason: 'Connected sentences.', doingWell: last.f.good, practise: last.f.next, closing: last.f.bye } }));
  assert.deepEqual(brain.toWire(brain.repairTurn(last)), last);
  assert.deepEqual(brain.repairTurn({ h: 'h', p: 'n', rd: 'p', r: 'Okay.' }), FULL({ happened: 'asked_for_help', picture: 'not_named', reading: 'partly', evidence: '', reply: 'Okay.' }));
  // The short answer is much shorter than the long one was.
  const long = JSON.stringify({ ...brain.repairTurn(hello), evidence: 'They gave their name in a clear English sentence.' }, null, 2);
  assert.ok(JSON.stringify(hello).length < long.length / 2.5, `${JSON.stringify(hello).length} characters against ${long.length}`);
  // A model that ignores the format (long names, nulls) is still understood; "f" without a level ends the talk on the app's rule.
  assert.equal(brain.repairTurn({ happened: 'gave_up', picture: null, reply: 'That is fine.', question: '', finish: false, final: null }).happened, 'gave_up');
  assert.deepEqual([brain.repairTurn({ h: 'a', r: 'Bye.', f: {} }).finish, brain.repairTurn({ h: 'a', r: 'Bye.', f: {} }).final], [true, null]);

  // It is asked for as plain JSON, checked here: a provider's own strict schema would force every field to be written.
  const seen = [];
  const s = convo.getSession(convo.startSession({ seed: 0 }).sessionId);
  const structured = async (p) => { seen.push(p); return { data: p.schema.parse(p.repair(hello)), provider: 'fake', model: 'fake-1', latencyMs: 1, usage: {}, costInr: 0, attempts: 1 }; };
  const t = await convo.handleTurn(s, { event: 'answer', transcript: 'My name is Prajwal', speechSec: 2 }, null, { structured });
  assert.equal(seen[0].schemaToProvider, false);
  assert.equal(say(t), "Nice to meet you, Prajwal. | There's a picture on your screen. What is it called in English?");
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
