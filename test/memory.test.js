// Sakhi's memory of each learner (server/learning/memory.js): pure parts always; against a real PostgreSQL
// (TEST_DATABASE_URL; skipped without it) with a mocked AI: memory notes, the prompt, the greeting, forgetting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// The database's address must be set before the server's modules load (they open the pool when imported).
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { sensitive, asksToForget, repairMemoryNote, MemoryNote, buildNoteMessages } = await import('../server/learning/memory.js');
const { learnerSection } = await import('../server/learning/prompts.js');

// ---- pure ----------------------------------------------------------------------------------------------

test('sensitive notes and contact details are never kept', () => {
  for (const s of ['Has diabetes', 'Is a Muslim', 'Earns a salary of 20,000', 'Has a loan for a bike', 'Phone 9876543210', 'Email ravi@x.in', 'Has a girlfriend in Delhi', 'Pays ₹500 rent'])
    assert.equal(sensitive(s), true, s);
  for (const s of ['Works in a call centre in Pune', 'Has a job interview at TCS', 'Likes cricket', 'Wants more Hindi explanations', 'Works as a nurse in a hospital', 'Celebrates Diwali with family'])
    assert.equal(sensitive(s), false, s);
});

test('"forget" is recognised in English and Hindi', () => {
  assert.ok(asksToForget('Please forget what I said about my job'));
  assert.ok(asksToForget('ye bhool jao'));
  assert.ok(asksToForget('इसे भूल जाओ'));
  assert.ok(!asksToForget('I forgot my bag')); // "forgot" is not a request
});

test('a near-miss memory note is repaired', () => {
  const r = MemoryNote.parse(repairMemoryNote({ add: [{ kind: 'job', content: 'Works in a bank', importance: '3', due_on: 'Friday' }], forget: ['4', { id: 5 }], summary: 'Talked about work.' }));
  assert.deepEqual(r.add, [{ kind: 'fact', content: 'Works in a bank', importance: 3, due_on: null }]);
  assert.deepEqual(r.forget, [4, 5]);
  assert.deepEqual(r.update, []);
  assert.equal(r.forget_all, false);
});

test('the note prompt shows what is known, with ids, and today\'s date', () => {
  const [sys, user] = buildNoteMessages({ known: [{ id: 7, kind: 'event', content: 'Has a job interview', due_on: '2026-11-28' }], summary: null,
    messages: [{ role: 'learner', content: 'I got the job!' }], now: new Date('2026-11-24T10:00:00Z') });
  assert.match(sys.content, /2026-11-24/);
  assert.match(user.content, /7\. event: Has a job interview \(date 2026-11-28\)/);
  assert.match(user.content, /Learner: I got the job!/);
});

test('the tutor prompt uses the memory, and nothing when the learner switched it off', () => {
  const learner = { today: '2026-11-24', items: [{ content: 'Works in a call centre' }], upcoming: [{ content: 'Has an interview', due_on: '2026-11-28' }],
    dueEvents: [{ content: 'Went to Goa', due_on: '2026-11-20' }], past: [{ summary: 'Talked about cricket.' }] };
  const s = learnerSection({ name: 'Ravi', level: 2 }, { facts: ['old placement fact'], learner });
  assert.match(s, /Works in a call centre/);
  assert.match(s, /Has an interview \(2026-11-28\)/);
  assert.match(s, /ask once how it went: Went to Goa/);
  assert.match(s, /Talked about cricket/);
  assert.doesNotMatch(s, /old placement fact/);
  const off = learnerSection({ name: 'Ravi' }, { facts: ['old placement fact'], learner: { off: true, items: [], upcoming: [], dueEvents: [], past: [] } });
  assert.doesNotMatch(off, /placement fact|remember/);
  assert.match(learnerSection({}, { facts: ['old placement fact'], learner: null }), /old placement fact/, 'admin switch off: as before');
});

// ---- with the database -----------------------------------------------------------------------------------

let pool, store, repo, memory, settings, createRuntime;
before(async () => {
  if (!url) return;
  ({ pool } = await import('../server/db/pool.js'));
  await pool.query('drop schema public cascade; create schema public');
  await (await import('../server/db/migrate.js')).migrate(pool, () => {});
  store = await import('../server/store.js');
  repo = await import('../server/learning/repo.js');
  memory = await import('../server/learning/memory.js');
  settings = await import('../server/settings.js');
  ({ createRuntime } = await import('../server/learning/runtime.js'));
});
after(async () => { await pool?.end(); });
const t = (name, fn) => test(name, { skip: !url && 'set TEST_DATABASE_URL to run' }, fn);
const rows = async (sql, p) => (await pool.query(sql, p)).rows;

/** A mocked AI: answers by schema name; remembers every call's prompt. */
function mockAi(answers) {
  const calls = [];
  const structured = async ({ job, schema, schemaName, messages }) => {
    calls.push({ job, schemaName, prompt: messages.map((m) => m.content).join('\n') });
    let a = answers[schemaName];
    if (typeof a === 'function') a = a(messages);
    if (a instanceof Error) throw a;
    return { data: schema.parse(a), provider: 'mock', model: 'mock-1', latencyMs: 3, usage: { input: 100, output: 20 }, attempts: 1 };
  };
  return { structured, calls };
}
const reply = { reply: 'Nice! Tell me more.', corrections: [], encouragement: null, follow_up_question: 'Tell me more?', learning_signals: [] };
const soon = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10); // an event a few days ahead
const emptyNote = { name: null, add: [], update: [], forget: [], done: [], forget_all: false, summary: null, topics: [] };

let user;
t('placement facts start the memory (once each)', async () => {
  user = await store.upsertUser({ firebaseUid: 'mem-1', phone: '+919800002001' });
  await store.addConversationFacts(user.id, ['Works in a call centre in Pune', 'Likes cricket']);
  await store.addConversationFacts(user.id, ['works in a call centre in pune']);
  const items = await memory.activeMemories(user.id);
  assert.deepEqual(items.map((m) => [m.content, m.source]).sort(), [['Likes cricket', 'placement'], ['Works in a call centre in Pune', 'placement']]);
});

let conv;
t('every 8 learner messages a memory note runs in the background and updates the memory', async () => {
  await settings.set('memory', { ...settings.SECTIONS.memory.defaults, everyMessages: 3 }, 'test');
  const [cricket] = (await memory.activeMemories(user.id)).filter((m) => m.content === 'Likes cricket');
  const ai = mockAi({
    tutor_turn: reply, verify: { decisions: [] },
    memory_note: {
      name: 'Ravi',
      add: [
        { kind: 'event', content: 'Has a job interview at TCS', due_on: soon, importance: 3 },
        { kind: 'fact', content: 'Has diabetes', due_on: null, importance: 2 },          // sensitive: dropped
        { kind: 'goal', content: 'Wants to speak confidently in interviews', due_on: null, importance: 3 },
        { kind: 'interest', content: 'Likes cricket', due_on: null, importance: 2 },     // known: not added twice
      ],
      update: [{ id: cricket.id, content: 'Likes cricket, especially IPL', due_on: null }, { id: 999999, content: 'Not theirs', due_on: null }],
      forget: [], done: [], forget_all: false, summary: 'Ravi talked about his interview next week.', topics: ['work', 'interview'],
    },
  });
  const rt = createRuntime({ structured: ai.structured });
  conv = await repo.createConversation({ userId: user.id });
  for (const [i, m] of ['Hi, I am Ravi', 'I have interview on Friday', 'I like IPL'].entries()) {
    await rt.respond({ userId: user.id, conversationId: conv.id, message: m, clientMessageId: `m${i}` });
    if (i < 2) { await memory.settled(); assert.ok(!ai.calls.some((c) => c.job === 'memory'), 'not before the third message'); }
  }
  await memory.settled();
  assert.equal(ai.calls.filter((c) => c.job === 'memory').length, 1);
  assert.match(ai.calls.find((c) => c.job === 'memory').prompt, /Learner: I like IPL/);
  const items = await memory.activeMemories(user.id);
  assert.deepEqual(items.map((m) => m.content).sort(), ['Has a job interview at TCS', 'Likes cricket, especially IPL', 'Wants to speak confidently in interviews', 'Works in a call centre in Pune']);
  assert.equal(items.find((m) => m.kind === 'event').due_on, soon);
  const [c] = await rows('select summary, topics, memory_through from conversations where id = $1', [conv.id]);
  assert.equal(c.summary, 'Ravi talked about his interview next week.');
  assert.deepEqual(c.topics, ['work', 'interview']);
  assert.ok(c.memory_through);
  assert.equal((await store.getUser(user.id)).name, 'Ravi');
  assert.equal(await memory.unreadCount(conv.id), 0);
});

t('the next turn\'s prompt carries the memory', async () => {
  const ai = mockAi({ tutor_turn: reply, verify: { decisions: [] }, memory_note: emptyNote });
  const rt = createRuntime({ structured: ai.structured });
  const other = await repo.createConversation({ userId: user.id });
  await rt.respond({ userId: user.id, conversationId: other.id, message: 'Hello again', clientMessageId: 'x1' });
  const prompt = ai.calls.find((c) => c.job === 'tutor').prompt;
  assert.match(prompt, /What you remember about them.*Works in a call centre in Pune/);
  assert.ok(prompt.includes(`Coming up for them: Has a job interview at TCS (${soon})`));
  assert.match(prompt, /Ravi talked about his interview next week/);
  await memory.settled();
});

t('saying "forget" runs a note at once; it forgets, marks events done, and "forget everything" needs the word', async () => {
  const items = await memory.activeMemories(user.id);
  const job = items.find((m) => m.content.startsWith('Works in')), event = items.find((m) => m.kind === 'event');
  const ai = mockAi({ tutor_turn: reply, verify: { decisions: [] }, memory_note: { ...emptyNote, forget: [job.id], done: [event.id], forget_all: true } });
  const rt = createRuntime({ structured: ai.structured });
  // The model asks to forget everything, but the learner never said "forget": only the single items go.
  const c2 = await repo.createConversation({ userId: user.id });
  await rt.respond({ userId: user.id, conversationId: c2.id, message: 'My interview went well', clientMessageId: 'f0' });
  await memory.settled();
  assert.equal(ai.calls.filter((c) => c.job === 'memory').length, 0, 'one message: no note yet');
  const r = await memory.noteConversation({ userId: user.id, conversationId: c2.id, structured: ai.structured });
  assert.equal(r.forgotAll, false, 'the learner never said "forget": not everything is wiped');
  assert.equal(r.forgotten, 1);
  assert.equal(r.done, 1);
  const left = (await memory.activeMemories(user.id)).map((m) => m.content).sort();
  assert.deepEqual(left, ['Likes cricket, especially IPL', 'Wants to speak confidently in interviews']);

  const ai2 = mockAi({ tutor_turn: reply, verify: { decisions: [] }, memory_note: { ...emptyNote, forget_all: true } });
  await createRuntime({ structured: ai2.structured }).respond({ userId: user.id, conversationId: c2.id, message: 'Please forget everything about me', clientMessageId: 'f1' });
  await memory.settled();
  assert.equal(ai2.calls.filter((c) => c.job === 'memory').length, 1, '"forget" runs a note at once');
  assert.equal((await memory.activeMemories(user.id)).length, 0);
  assert.equal((await rows('select count(*)::int as n from conversations where user_id = $1 and summary is not null', [user.id]))[0].n, 0);
  assert.equal((await store.getUser(user.id)).attributes.conversation_facts, undefined);
});

t('a new conversation: earlier talk is noted first, then a personal greeting; the event it asks about is done', async () => {
  const u = await store.upsertUser({ firebaseUid: 'mem-2', phone: '+919800002002' });
  const ai = mockAi({
    tutor_turn: reply, verify: { decisions: [] },
    memory_note: { ...emptyNote, add: [{ kind: 'event', content: 'Went to Goa with friends', due_on: '2026-11-01', importance: 2 }], summary: 'Talked about a trip to Goa.' },
    greeting: (messages) => ({ greeting: 'Hi! How was your Goa trip?', asked_about: [Number(messages[1].content.match(/(\d+)\. Went to Goa/)[1])] }),
  });
  const rt = createRuntime({ structured: ai.structured });
  const first = await rt.startConversation({ userId: u.id, profile: await repo.profile(u.id) });
  assert.match(first.greeting.content, /What would you like to talk about/, 'nothing remembered yet: the plain greeting');
  await rt.respond({ userId: u.id, conversationId: first.conversation.id, message: 'I am going to Goa', clientMessageId: 'g1' });
  await memory.settled();
  const second = await rt.startConversation({ userId: u.id, profile: await repo.profile(u.id) });
  assert.equal(second.greeting.content, 'Hi! How was your Goa trip?');
  assert.equal(second.greeting.metadata.personal, true);
  assert.deepEqual(ai.calls.map((c) => c.schemaName).filter((s) => s !== 'tutor_turn' && s !== 'verify'), ['memory_note', 'greeting']);
  assert.equal((await memory.activeMemories(u.id)).length, 0, 'asked about once: done');

  // The AI failing: the plain greeting.
  const broken = createRuntime({ structured: mockAi({ greeting: new Error('down'), memory_note: emptyNote }).structured });
  await memory.noteConversation({ userId: u.id, conversationId: second.conversation.id, structured: ai.structured }); // nothing new: skipped
  assert.match((await broken.startConversation({ userId: u.id, profile: await repo.profile(u.id) })).greeting.content, /I'm Sakhi/);
});

t('the learner\'s switch: off means nothing is noted or recalled; the admin switch turns it all off', async () => {
  const u = await store.upsertUser({ firebaseUid: 'mem-3', phone: '+919800002003' });
  await store.addConversationFacts(u.id, ['Lives in Jaipur']);
  await repo.profile(u.id);
  await repo.updatePreferences(u.id, { memoryEnabled: false });
  assert.equal((await repo.profile(u.id)).memoryEnabled, false);
  assert.deepEqual((await memory.recall(u.id)).items, []);
  assert.equal((await memory.recall(u.id)).off, true);
  const c = await repo.createConversation({ userId: u.id });
  await repo.addLearnerMessage({ conversationId: c.id, content: 'I live in Jaipur', channel: 'text' });
  assert.deepEqual(await memory.noteConversation({ userId: u.id, conversationId: c.id, structured: mockAi({}).structured }), { skipped: 'the learner switched memory off' });
  await store.addConversationFacts(u.id, ['Has two kids']);
  assert.deepEqual((await memory.activeMemories(u.id)).map((m) => m.content), ['Lives in Jaipur'], 'switched off: placement facts are not added');

  await settings.set('memory', { ...settings.SECTIONS.memory.defaults, enabled: false }, 'test');
  assert.equal(await memory.recall(user.id), null);
  await settings.reset('memory', 'test');
});

t('forgetting one item, everything, and old summaries', async () => {
  const u = await store.upsertUser({ firebaseUid: 'mem-4', phone: '+919800002004' });
  const other = await store.upsertUser({ firebaseUid: 'mem-5', phone: '+919800002005' });
  await store.addConversationFacts(u.id, ['Lives in Pune', 'Has a dog']);
  const [a] = await memory.activeMemories(u.id);
  assert.equal(await memory.forget(other.id, a.id), false, 'not theirs');
  assert.equal(await memory.forget(u.id, a.id), true);
  assert.equal((await memory.view(u.id)).items.length, 1);

  const c = await repo.createConversation({ userId: u.id });
  await pool.query(`update conversations set summary = 'Old talk.', last_message_at = now() - interval '400 days' where id = $1`, [c.id]);
  assert.equal(await memory.expireSummaries(), 1);
  assert.equal((await memory.view(u.id)).conversations.length, 0);
});
