// The conversation placement (Settings › Placement test › mode "conversation"): the alternative to the classic
// five-part test in server/session.js, which stays as it is.
//
// The talk goes from easy to hard:
//   1. Hello     "Hi, my name is Sakhi. What is your name?"
//   2. Picture   "What is this called in English?"            (a picture on the screen)
//   3. Reading   one line on the screen, read out loud
//   4. Talking   open questions, for those who can go on
// EVERY learner turn goes to the AI (brain.js), which writes all of Sakhi's words and makes every judgement:
// what the learner meant, whether the picture was named, how the line was read, whether to go on, the level of
// each answer, when to finish, and the final level with its feedback.
// This file only: keeps the order of the steps and what is on the screen; limits how often a step is repeated
// (help twice, a steer back once); gives the AI a few facts (which words matched, how many English words);
// stops her giving away the picture's word or the line to read; and, if the AI is slow or fails, carries on
// with the app's own checks and fixed lines (the level then comes from the rule in level.js).
// The app sees the same reply shape as the classic test, so it needs no change:
//   { sessionId, say: [{text, lang, pace}], card, cue, listen, task, done? }
import { randomUUID } from 'node:crypto';
import { LEVELS, PHRASES } from '../../shared/assessment.js';
import { BANK } from '../../shared/bank.js';
import { voiceLanguage } from '../../shared/languages.js';
import { features, vocabHits, readAccuracy } from '../scoring.js';
import { isUnintelligible, detectClarification } from '../clarify.js';
import { makeLedger } from '../costs.js';
import { speechSeconds } from '../sarvam.js';
import { stripInventedNames, fixContractions } from '../tutor.js';
import * as settings from '../settings.js';
import { takesEffort, streams } from '../llm/index.js';
import { normalizeForCompare } from '../normalize.js';
import { think, summarize, plainSummary, usableFinal, tipIsTheirs, learnerLine, cutOffLine, appLine } from './brain.js';
import { nextStep, placementLevel, missedLevel, qualifies, READ_OK, OPEN_START } from './level.js';

const HELLO = { en: 'Hi, my name is Sakhi. What is your name?', hi: 'नमस्ते, मेरा नाम सखी है। आपका नाम क्या है?' };
const HELLO_AGAIN = { en: 'What is your name?', hi: 'आपका नाम क्या है?' };
const READ = { en: 'Please read this sentence out loud.', hi: 'स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।' };
const SAY = { meet: 'Nice to meet you!', yes: "Yes, that's right!", thanks: 'Thank you!', noProblem: 'No problem.' };
const called = (word) => `In English, this is called '${word}'.`;
const levelLine = (level) => `Thank you! Your English is at level ${level} of 4, ${LEVELS[level].name}.`;
const ACK = { en: 'Okay.', hi: 'ठीक है।' };
const INDIC = /[ऀ-ൿ]/;
// One at random; with a seed (the admin's model comparison), the same one in every talk.
const pick = (list, seed = null) => list[seed == null ? Math.floor(Math.random() * list.length) : seed % list.length];
// What the screen shows for the picture and the reading (the same card shapes as the classic test).
const pictureCard = (v) => ({ text: v.screen, kind: 'task', look: 'emoji', band: { en: 'What is this? Say it in English.', hi: 'यह क्या है? अंग्रेज़ी में बोलिए।' } });
const readCard = (v) => ({ text: v.screen, kind: 'read', look: 'sentence', band: { en: 'Read this sentence out loud.', hi: 'इस वाक्य को ज़ोर से पढ़िए।' } });

const sessions = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [id, s] of sessions) if (now - s.at > TTL_MS) sessions.delete(id); }, 10 * 60 * 1000).unref();
export const getSession = (id) => sessions.get(id);

// ---- lines ------------------------------------------------------------------------------------------
const line = (text, pace = 1) => ({ text, lang: voiceLanguage(text), pace });
/** Sakhi's words as voice lines: English sentences and Hindi sentences go to their own voices. */
export function linesOf(text, pace = 1) {
  const parts = (String(text || '').match(/[^.!?।]+[.!?।]*\s*/g) || []).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const hindi = INDIC.test(p), last = out[out.length - 1];
    if (last && last.hindi === hindi) last.text += ` ${p}`; else out.push({ text: p, hindi });
  }
  return out.map((o) => line(o.text, o.hindi ? Math.min(pace, 0.95) : pace));
}
/** The model's words, made safe to say: no invented names, apostrophes restored, plain spaces and quotes. */
const clean = (text, name) => fixContractions(stripInventedNames(String(text || '').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim(), name)) || '';
const withoutQuestions = (text) => (text.match(/[^.!?।]+[.!?।]*\s*/g) || []).filter((x) => !x.includes('?')).join('').trim();
const bankQuestion = (target) => { const pool = BANK.speak[target] || BANK.speak[2]; const v = pool[Math.floor(Math.random() * pool.length)]; return target <= 2 && v.hindi ? `${v.say} ${v.hindi}` : v.say; };

/** Lines worth generating ahead (the voice cache), and the fixed lines Sakhi may always say. */
export function scriptedLines() {
  return [
    line(HELLO.en), line(HELLO.hi, 0.95), line(HELLO_AGAIN.en, 0.9), line(HELLO_AGAIN.hi, 0.9), ...Object.values(SAY).map((t) => line(t)),
    ...BANK.vocab[1].flatMap((v) => [line(v.say), line(v.hindi, 0.95), line(v.simple || v.say, 0.9), line(v.hindi, 0.9), line(called(v.expect[0][0])), line(`${SAY.noProblem} ${called(v.expect[0][0])}`)]),
    line(READ.en), line(READ.hi, 0.95), line(READ.en, 0.9), line(READ.hi, 0.9),
    ...BANK.open.flatMap((o) => [line(o.simple), line(o.hindi, 0.95)]),
    line(PHRASES.didntHear, 0.95), line(PHRASES.moveOn), line(ACK.en), line(ACK.hi, 0.95),
    ...[1, 2, 3, 4].map((l) => line(levelLine(l))), line(LEVELS[1].hindi, 0.95), line(LEVELS[2].hindi, 0.95),
  ];
}

// ---- the session -------------------------------------------------------------------------------------
export function startSession({ lab = false, seed = null } = {}) {
  const s = {
    id: randomUUID(), mode: 'conversation', lab, seed, at: Date.now(), history: [], answers: [], ratings: [],
    profile: { name: null, facts: [], language: null },
    q: { step: 'hello', text: HELLO.en, helps: 0, steers: 0 },
    picture: null, read: null, // what the AI judged on those two steps
    vocab: pick(BANK.vocab[1], seed), // the picture they will be shown, chosen now so a reply can be checked against it early
    recorded: null, // what the app recorded from the turn just judged, to be told once in the next STEP line
    done: false, result: null, prev: null, ledger: makeLedger(),
  };
  sessions.set(s.id, s);
  // The opening is the one fixed line: there is nothing to respond to yet.
  return respond(s, [], [line(HELLO.en), line(HELLO.hi, 0.95)], { plan: 'opening' });
}

/**
 * The app's line after each of Sakhi's turns: the step the learner is now answering, what she needs for it, what
 * was recorded from the turn before, and what she may stay on the step for. Said once, and kept in the talk.
 */
function stepLine(s) {
  const q = s.q, max = settings.get('placement').maxQuestions, still = q.helps + q.steers > 0;
  const step = { hello: 'HELLO', picture: 'PICTURE', read: 'READING', open: `OPEN QUESTION ${q.n} of ${max}` }[q.step];
  const words = q.v?.expect?.[0];
  const need = still ? '' // already said when the step began
    : q.step === 'picture' ? ` The picture on their screen shows: ${words[0]}${words.length > 1 ? ` (also right: ${words.slice(1).join(', ')})` : ''}.`
    : q.step === 'read' ? ` The line on their screen (NEVER say it): "${q.v.screen}"` : '';
  const last = q.step === 'open' && q.n >= max ? ' It is the last question: when you move on from it, finish.' : '';
  // How often she may stay on one step: twice for help, once for something off the point.
  const may = [q.helps < 2 && 'help', q.steers < 1 && 'something else'].filter(Boolean).join(', ') || 'nothing';
  const recorded = s.recorded ? `RECORDED: ${s.recorded}. ` : '';
  s.recorded = null;
  return appLine(`${recorded}STEP: ${step}${still ? ', still' : ''}.${need}${last} You may stay for: ${may}.`);
}

/** Say `before` (a reaction) and then `ask` (the question): the reply the app plays. step: false when nothing about the step changed. */
function respond(s, before, ask = [], extra = {}, { step = true } = {}) {
  const lines = [...before, ...ask], q = s.q;
  if (lines.length) s.lastSay = { lines, askAt: before.length };
  for (const l of lines) s.history.push({ who: 'sakhi', text: l.text });
  if (lines.length && step && !s.done) s.history.push({ who: 'app', text: stepLine(s) });
  return {
    sessionId: s.id, say: lines, card: s.done ? null : q.card || null,
    cue: { line: ask.length ? before.length : Math.max(0, lines.length - 1), word: 0 }, learnerLanguage: null,
    // Reading is always English, so speech-to-text doesn't have to guess the language.
    listen: s.done ? null : q.step === 'read' ? { silenceMs: 1300, language: 'en-IN' } : { silenceMs: q.step === 'open' ? 1600 : 1200, language: 'auto' },
    task: s.done ? null : { id: q.step === 'open' ? `c${q.n}` : q.step, level: q.target ?? 1, kind: { hello: 'open', picture: 'vocab', read: 'read', open: 'open' }[q.step], item: q.item || null },
    ...extra,
  };
}

const NOT_A_NAME = new Set('yes no hello hi sorry what okay ok namaste hindi english repeat again fine good here ready from not very happy the my name is am'.split(' '));
/** Their first name, only if they clearly said it ("My name is Ravi", "I am Ravi", or just "Ravi"). Used when the AI fails. */
export function nameIn(t) {
  const cap = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
  const ok = (w) => w && /^[A-Za-z]{2,20}$/.test(w) && !NOT_A_NAME.has(w.toLowerCase());
  const m = t.match(/\b(?:my name is|my name's|name is|i am|i'm|this is|myself)\s+([A-Za-z]+)/i);
  if (m) return ok(m[1]) ? cap(m[1]) : null;
  const w = t.replace(/[.!,?]/g, ' ').trim().split(/\s+/);
  return w.length <= 2 && w.every(ok) ? cap(w[0]) : null;
}

// The fixed words for each step: what Sakhi says if the AI gives no usable line.
const fixedAsk = (q, again = false) => (q.step === 'hello' ? [line(HELLO_AGAIN.en, 0.9), line(HELLO_AGAIN.hi, 0.9)]
  : q.step === 'picture' ? (again ? [line(q.v.simple || q.v.say, 0.9), line(q.v.hindi, 0.9)] : [line(q.v.say), line(q.v.hindi, 0.95)])
  : q.step === 'read' ? [line(READ.en, again ? 0.9 : 1), line(READ.hi, again ? 0.9 : 0.95)] : linesOf(q.text, again ? 0.9 : 1));
const READ_RESULT = (acc) => (acc >= READ_OK ? 'well' : acc >= 0.4 ? 'partly' : 'not');

/**
 * This turn, as the AI is given it: the talk so far, the learner's words, and the one thing the app adds about
 * those words (measured). Everything else the AI needs is already in the talk or in its fixed instructions.
 * Also what the app itself needs to apply the answer. Changes nothing.
 */
export function buildCtx(s, input) {
  // said: their new words. t: the whole answer, which is longer when this is the rest of one they were still giving.
  const q = s.q, said = (input.transcript || '').trim(), t = `${input.joinTo?.transcript || ''} ${said}`.trim(), max = settings.get('placement').maxQuestions;
  const spoke = input.event === 'answer' && !isUnintelligible(said);
  const f = spoke ? features(t, { speechSec: (input.joinTo?.speechSec || 0) + (input.speechSec || 0), kind: 'open', timing: input.joinTo ? null : input.timing }) : null;
  let hit = null, acc = null, measured = null;
  if (q.step === 'picture') {
    const words = q.v.expect[0];
    hit = spoke && vocabHits(t, [words])[0]; // the server's own check: used only if the AI gives no judgement
  } else if (q.step === 'read') {
    acc = spoke ? readAccuracy(q.v.screen, t) : 0;
    const total = q.v.screen.split(/\s+/).length;
    if (spoke) measured = `about ${Math.round(acc * total)} of the line's ${total} words are in their reply.`;
  } else if (q.step === 'open' && f) {
    measured = input.joinTo ? `${f.englishWordCount} English words in the whole answer, all its parts together.` : `${f.englishWordCount} English words.`;
  }
  return {
    history: [...s.history], step: q.step, n: q.n, event: input.event, transcript: t, said,
    // Their turn as it is sent now and kept in the talk afterwards: the same words both times.
    line: learnerLine(spoke ? 'answer' : input.event === 'answer' ? 'live_failed' : input.event, said),
    measured: measured && appLine(`MEASURED: ${measured}`),
    mustFinish: q.step === 'open' && q.n >= max, // the last question allowed: the talk ends when she moves on from it
    // How often she may stay on one step: twice for help, once for something off the point (as the STEP line said).
    stayFor: { asked_for_help: q.helps < 2 && input.event !== 'skip', something_else: q.steers < 1 },
    spoke, features: f, hit, accuracy: acc,
  };
}

/** What the turn is taken as when the AI gave nothing usable: the app's own checks, and the fixed lines. */
function plainTurn(s, ctx) {
  const q = s.q, f = ctx.features;
  const out = { happened: ctx.spoke ? 'answered' : ctx.event === 'skip' ? 'gave_up' : 'asked_for_help', picture: null, reading: null, level: null,
    evidence: "The AI did not answer: taken from the app's own checks.", tip: null, name: null, reply: '', question: '', finish: false, final: null };
  if (ctx.spoke && detectClarification(ctx.transcript) && !(ctx.accuracy >= 0.3)) out.happened = detectClarification(ctx.transcript) === 'dont_know' ? 'gave_up' : 'asked_for_help';
  const answered = out.happened === 'answered';
  if (q.step === 'hello') { out.name = answered ? nameIn(ctx.transcript) : null; out.reply = answered ? (out.name ? `Nice to meet you, ${out.name}!` : SAY.meet) : ''; }
  else if (q.step === 'picture') {
    const word = q.v.expect[0][0];
    out.picture = answered ? (ctx.hit ? 'named' : 'not_named') : null;
    out.reply = answered ? (ctx.hit ? SAY.yes : called(word)) : out.happened === 'gave_up' ? `${SAY.noProblem} ${called(word)}` : '';
  } else if (q.step === 'read') {
    out.reading = answered ? READ_RESULT(ctx.accuracy) : null;
    out.reply = answered ? SAY.thanks : out.happened === 'gave_up' ? PHRASES.moveOn : '';
    out.finish = !qualifies({ picture: s.picture?.result === 'named', readAccuracy: answered ? ctx.accuracy : 0 }) && !(out.happened === 'asked_for_help' && ctx.stayFor.asked_for_help);
  } else {
    out.level = answered ? (f.englishWordCount < 3 || f.nonLatinRatio > 0.5 ? 1 : f.englishWordCount < 12 ? 2 : 3) : null;
    out.reply = f && (f.nonLatinRatio > 0.3 || f.englishWordCount < 3) ? ACK.hi : out.happened === 'gave_up' ? PHRASES.moveOn : ACK.en;
    const level = out.level ?? missedLevel(q.target);
    out.finish = ctx.mustFinish || (!(out.happened === 'asked_for_help' && ctx.stayFor.asked_for_help) && nextStep([...s.ratings, { level }], settings.get('placement').maxQuestions).done);
  }
  return out;
}

/**
 * One learner turn. Every turn goes to the AI (brain.js); the app only replays her last question on "repeat".
 * input: { event: 'answer'|'no_speech'|'live_failed'|'skip'|'repeat'|'in_hindi', transcript?, languageCode?, speechSec?, timing?, interrupted? }
 * opts: { config, summaryConfig, structured, timeoutMs, detail, efforts: { turn, final }, speed } (tests and the model comparison);
 *       onReply(lines): her reaction's lines, as soon as they are known (a provider that streams): see askAI below
 *       commit(lines) → true: those lines have gone to the app, which is already saying them. From then on they
 *         ARE her reaction for this turn, whatever the rest of the answer turns out to be.
 */
export async function handleTurn(s, input, trace, opts = {}) {
  s.at = Date.now();
  const note = (step, data) => trace?.add(step, data);
  if (s.done) return respond(s, [], [], { done: s.result });
  if (!['answer', 'no_speech', 'live_failed', 'skip', 'repeat', 'in_hindi'].includes(input.event)) throw Object.assign(new Error(`unknown event "${input.event}"`), { status: 400 });
  if (input.event === 'repeat') {
    // Her own words again, more slowly: nothing new to respond to.
    note('plan', { next: 'the question again, slower' });
    s.history.push({ who: 'learner', text: learnerLine('repeat') });
    return respond(s, [], s.lastSay?.askAt < s.lastSay?.lines.length ? s.lastSay.lines.slice(s.lastSay.askAt).map((l) => ({ ...l, pace: Math.min(l.pace, 0.85) })) : fixedAsk(s.q, true), {}, { step: false });
  }

  // They talked over Sakhi. Nothing already in the talk is changed: her whole turn stays as she said it, and a
  // line from the app is added after it saying how much of it they heard.
  if (input.event === 'answer' && input.interrupted && s.lastSay) {
    const heard = heardOf(s, input.interrupted), p = !heard.askHeard && s.prev;
    if (p) {
      // Before she reached her question (open questions): they were still finishing their last answer. Their new
      // words are added as a new turn, and the app's line tells the AI to judge the parts together as one answer
      // to the earlier question. Only the app's own record of that answer (its level) is taken back, to be judged
      // again; the step goes back to that question, which a new STEP line says.
      s.ratings.length = p.ratings; s.answers.length = p.answers; s.q = { ...p.q };
      input = { ...input, joinTo: { transcript: p.transcript, speechSec: p.speechSec } };
      s.history.push({ who: 'app', text: cutOffLine(heard, p.q.text) }, { who: 'app', text: stepLine(s) });
    } else if (heard.rest) s.history.push({ who: 'app', text: cutOffLine(heard) });
    note('interrupted', { heard: heard.text, askHeard: heard.askHeard, ...(p ? { next: 'judge it with their previous answer, as one' } : {}) });
  }

  const ctx = buildCtx(s, input);
  const P = settings.get('placement'), config = opts.config || P.brain;
  // How hard the model thinks: the settings, unless this talk was given its own (the model comparison).
  const E = { turn: opts.efforts?.turn ?? P.turnEffort, final: opts.efforts?.final ?? P.finalEffort };
  const fast = (opts.speed ?? P.speed) === 'fast'; // OpenAI's Fast mode, for the models that have it
  // One call to the AI. as: the name it goes by in the trace.
  let said = null; // her reaction, once it has gone to the app
  const askAI = async (c, effort, as) => {
    const t0 = performance.now();
    // With a provider that streams: her reaction is known before the rest of the answer is written, so its
    // voice can be started (opts.onReply) while the model is still writing her question.
    const onReply = as === 'brain' && streams(config.provider) ? (part, ms) => {
      const lines = earlyReply(s, c, part);
      note('early-reply', { ms, lines: lines?.map((l) => l.text) ?? null });
      if (!lines?.length) return;
      opts.onReply?.(lines);
      if (!opts.commit) return;
      s.saying = lines.map((l) => l.text); // her voice may say them from now: the app asks for them before the turn is finished
      if (opts.commit(lines)) said = lines;
    } : null;
    const r = await think(c, { config, structured: opts.structured, wantThinking: !!opts.detail, effort, onReply, fast, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    // The whole request and the answer as it came, only where someone will read them (the model comparison).
    if (opts.detail) note(as === 'brain' ? 'exchange' : 'final-exchange', { messages: r.messages, raw: r.meta.raw ?? null, thinking: r.meta.thinking ?? null, attempts: r.meta.attempts });
    note(as, { model: `${r.meta.provider}/${r.meta.model}`, ms: Math.round(performance.now() - t0), firstTextMs: r.meta.firstTextMs ?? null, replyMs: r.meta.replyMs ?? null, costInr: r.meta.costInr ?? null, usage: r.meta.usage, effort: takesEffort(config.provider) ? effort : null, tier: r.meta.tier ?? null, askedFast: fast && config.provider === 'openai', at: c.step, ...r.out });
    return r.out;
  };
  // How hard the model thinks: lightly on a turn (speed), more for the final level and feedback (care).
  let out, ai = true;
  try { out = await askAI(ctx, ctx.mustFinish ? E.final : E.turn, 'brain'); }
  catch (e) {
    note('brain-failed', { why: e.message, using: "the app's own checks and fixed lines" });
    out = plainTurn(s, ctx); ai = false;
  }
  // The AI chose to end the talk on a turn it only thought about lightly: the same turn again with more thought,
  // told to finish, so the final level and feedback always get the care set for them. (One more call, only then.)
  // The turn itself stays as first answered (her reply may already be on its way to being spoken).
  const ends = (o) => o.finish && ['read', 'open'].includes(ctx.step) && !stays(ctx, o);
  if (ai && ends(out) && !ctx.mustFinish && E.final !== E.turn && takesEffort(config.provider)) {
    try {
      const again = await askAI({ ...ctx, extra: appLine('You have heard enough to be sure of their level. Finish now: leave out "q" and add "f".') }, E.final, 'final-evaluation');
      if (again.final) out = { ...out, final: again.final };
      else note('plan', { next: "keep the first answer's level", why: 'the final evaluation gave no level' });
    } catch (e) { note('final-evaluation-failed', { why: e.message, using: "the turn's own answer" }); }
  }
  return advance(s, ctx, out, input, note, opts, ai, said);
}

/** A name is only kept if they said it (in English letters it must be in their words). */
const nameSaid = (ctx, out) => (out.name && ctx.spoke && (INDIC.test(ctx.transcript) || ctx.transcript.toLowerCase().includes(out.name.toLowerCase())) ? out.name : null);
/**
 * Her reaction as it will be said, worked out as soon as the reply is written (before her question, and before
 * it is known whether the talk ends). null when it can't be known yet: a reply the guards may drop.
 */
export function earlyReply(s, ctx, part) {
  const q = s.q, reply = clean(part.reply, nameSaid(ctx, part) || s.profile.name);
  if (!reply) return null;
  const kept = (step, from) => safeToSay(step, reply, '', () => {}, from).reply === reply;
  if (stays(ctx, part)) return kept(q) ? linesOf(withoutQuestions(reply)) : null;
  // Moving on (or finishing). The picture is the one coming step whose word a reply could give away; the line to
  // read next isn't chosen yet, so a reply that happens to hold four of its words in a row is dropped later
  // (its voice was then started for nothing: rare, and harmless).
  const next = q.step === 'hello' ? { step: 'picture', v: s.vocab } : { step: 'open' };
  return kept(next, q) ? linesOf(withoutQuestions(reply)) : null;
}

/** What the turn is taken as: silence can't be an answer. */
const happenedIn = (ctx, out) => (ctx.spoke || out.happened !== 'answered' ? out.happened : 'asked_for_help');
/** Will she stay on the step? Help (twice at most) or a steer back (once). */
function stays(ctx, out) {
  const h = happenedIn(ctx, out);
  return (h === 'asked_for_help' && ctx.stayFor.asked_for_help) || (h === 'something_else' && ctx.stayFor.something_else);
}

/**
 * Apply the AI's turn: remember what it judged, then stay on the step, move to the next, or finish.
 * said: her reaction's lines when they have already gone to the app (see handleTurn's commit): used as they are.
 */
async function advance(s, ctx, out, input, note, opts, ai, said = null) {
  const q = s.q, transcript = ctx.transcript;
  // What the app recorded before this answer, in case they turn out to be still finishing it (see handleTurn).
  const before = { ratings: s.ratings.length, answers: s.answers.length, q: { ...q }, transcript, speechSec: (input.joinTo?.speechSec || 0) + (input.speechSec || 0) };
  s.prev = null; // only the turn just before can be carried on
  s.history.push({ who: 'learner', text: ctx.line });
  if (ctx.measured) s.history.push({ who: 'app', text: ctx.measured }); // exactly as it was sent, so the next request repeats this one
  if (nameSaid(ctx, out)) s.profile.name = out.name;
  let reply = clean(out.reply, s.profile.name), question = clean(out.question, s.profile.name);
  const heard = ctx.spoke ? transcript : undefined;
  const h = happenedIn(ctx, out);

  // Stay on the step: help (twice at most) or a steer back (once).
  if (stays(ctx, out)) {
    if (h === 'asked_for_help') q.helps++; else q.steers++;
    note('plan', { next: 'the same step again', why: h, helps: q.helps, steers: q.steers });
    ({ reply, question } = safeToSay(q, reply, question, note));
    // Her reply never holds a question (the fixed instructions say so; this is the net): what she asks follows it.
    return respond(s, said || linesOf(withoutQuestions(reply)), question ? linesOf(question, 0.95) : fixedAsk(q, true), { heard });
  }
  const answered = h === 'answered', skipped = h === 'could_not';
  const entry = { item: q.item || null, variantLevel: q.target ?? 1, neededHindi: q.helps > 0, languageCode: input.languageCode || null, skipped: !answered, transcript: ctx.spoke ? transcript : null };
  let next;

  if (q.step === 'hello') {
    const v = s.vocab;
    next = { step: 'picture', v, item: v.id, text: v.say, target: 1, card: pictureCard(v), helps: 0, steers: 0 };
  } else if (q.step === 'picture') {
    const result = answered ? (out.picture || (ctx.hit ? 'named' : 'not_named')) : skipped ? 'skipped' : 'not_named';
    s.picture = { result, word: q.v.expect[0][0] };
    s.answers.push({ ...entry, questionId: 'picture', kind: 'vocab', features: { vocabHits: [!!ctx.hit] }, scores: { vocabulary: result === 'named' ? 4 : 0 }, judged: result, evidence: out.evidence });
    s.recorded = `picture ${result.replace('_', ' ')}`;
    note('judged', { on: 'picture', result, appCheck: ctx.hit });
    // An everyday line for someone who knew the word; a very simple one otherwise.
    const level = result === 'named' ? 2 : 1, v = pick(BANK.read[level], s.seed);
    next = { step: 'read', v, item: v.id, text: READ.en, target: level, card: readCard(v), helps: 0, steers: 0 };
  } else if (q.step === 'read') {
    const result = answered ? (out.reading || READ_RESULT(ctx.accuracy)) : skipped ? 'skipped' : 'not';
    s.read = { result, accuracy: ctx.spoke ? ctx.accuracy : null, level: q.target };
    s.answers.push({ ...entry, questionId: 'read', kind: 'read', features: { readAccuracy: ctx.accuracy || 0 }, scores: { pronunciation: +((ctx.accuracy || 0) * 4).toFixed(2) }, judged: result, evidence: out.evidence });
    s.recorded = `reading ${result}`;
    note('judged', { on: 'reading', result, appMatched: ctx.accuracy });
    if (out.finish) return finish(s, reply, out.final, heard, note, opts, ai, said);
    const open = pick(BANK.open, s.seed);
    next = { step: 'open', n: 1, text: question || open.simple, target: OPEN_START, helps: 0, steers: 0, fixed: question ? null : [line(open.simple), line(open.hindi, 0.95)] };
  } else {
    const f = ctx.features || {};
    if (answered) {
      const level = out.level ?? plainTurn(s, ctx).level ?? 1;
      const tip = tipIsTheirs(out.tip, transcript) ? out.tip : null;
      s.ratings.push({ level, target: q.target, englishWords: f.englishWordCount || 0 });
      s.answers.push({ ...entry, questionId: `c${q.n}`, kind: 'open', question: q.text, features: f, scores: { level }, rated: level, evidence: out.evidence, tip });
      s.prev = before;
      s.recorded = `open answer ${q.n}${input.joinTo ? ' (all its parts)' : ''}: level ${level} (${f.englishWordCount || 0} English words)`;
      note('judged', { on: `open question ${q.n}`, level, englishWords: f.englishWordCount || 0 });
    } else {
      s.ratings.push({ level: missedLevel(q.target), target: q.target, englishWords: 0, missed: true });
      s.answers.push({ ...entry, questionId: `c${q.n}`, kind: 'open', question: q.text, features: {}, scores: {}, rated: null, evidence: out.evidence || "Didn't answer this question.", tip: null });
      s.prev = null;
      s.recorded = `open question ${q.n} not answered`;
      note('judged', { on: `open question ${q.n}`, missed: true, why: h });
    }
    if (out.finish || ctx.mustFinish) return finish(s, reply, out.final, heard, note, opts, ai, said);
    const target = Math.min(4, (s.ratings.at(-1).level || 2) + 1);
    next = { step: 'open', n: q.n + 1, text: question || bankQuestion(target), target, helps: 0, steers: 0 };
  }

  s.q = next;
  ({ reply, question } = safeToSay(next, reply, question, note, q));
  const ask = question ? linesOf(question) : next.fixed || fixedAsk(next);
  if (!question) note('plan', { next: 'a fixed line', why: ai ? 'the AI gave no usable line' : 'the AI did not answer' });
  return respond(s, said || linesOf(withoutQuestions(reply)), ask, { heard });
}

/**
 * Two things Sakhi must never give away: the picture's word before they've answered, and the line to read.
 * A reply or question that does is dropped (the fixed line is used instead).
 * q: the step the words lead into; from: the step just finished (its picture word may now be said).
 */
function safeToSay(q, reply, question, note, from = null) {
  const has = (text, words) => { const t = ` ${normalizeForCompare(text).join(' ')} `; return words.some((w) => t.includes(` ${normalizeForCompare(w).join(' ')} `)); };
  const reads = (text, sentence) => { const ref = normalizeForCompare(sentence), t = ` ${normalizeForCompare(text).join(' ')} `; for (let i = 0; i + 4 <= ref.length; i++) if (t.includes(` ${ref.slice(i, i + 4).join(' ')} `)) return true; return false; };
  const bad = (text) => text && ((q.step === 'picture' && has(text, q.v.expect[0])) || [q, from].some((x) => x?.step === 'read' && reads(text, x.v.screen)));
  if (bad(question)) { note('guard', { dropped: 'question', why: 'it gave away the picture or the line' }); question = ''; }
  if (bad(reply) && !(from?.step === 'picture' && q.step !== 'picture')) { note('guard', { dropped: 'reply', why: 'it gave away the picture or the line' }); reply = ''; }
  return { reply, question };
}

/** The end: the AI's level and feedback (final), or the app's own rule and plain feedback when it gave none. */
async function finish(s, reply, final, heard, note, opts, ai, spoken = null) { // spoken: her reaction's lines, if they have already gone to the app
  const facts = [
    s.picture && `Picture: ${s.picture.result.replace('_', ' ')}.`,
    s.read && `Reading: ${s.read.result}${s.read.accuracy != null ? ` (the app matched ${Math.round(s.read.accuracy * 100)}% of the line)` : ''}.`,
    s.ratings.length && `Open answers: ${s.ratings.map((r) => (r.missed ? 'not answered' : `level ${r.level}`)).join(', ')}.`,
  ].filter(Boolean).join(' ');
  const said = s.answers.filter((a) => a.kind === 'open' && !a.skipped).map((a) => ({ transcript: a.transcript, level: a.rated, evidence: a.evidence, tip: a.tip }));
  const known = [s.picture?.result === 'named' && `You know English words like '${s.picture.word}'.`, ['well', 'partly'].includes(s.read?.result) && 'You can read an English sentence out loud.'].filter(Boolean);
  let level, reasons, sum, by;
  if (final) {
    level = final.level; by = 'the AI';
    reasons = [final.reason || 'Decided by the AI from the whole talk.', facts].filter(Boolean);
    const u = usableFinal(final), plain = plainSummary({ answers: said, level, known });
    sum = { doingWell: u.doingWell.length ? u.doingWell : plain.doingWell, practise: u.practise.length ? u.practise : plain.practise, closing: u.closing || plain.closing };
  } else {
    // The AI gave no level (it failed, or left it out): the app's own rule, and feedback from a second call.
    const rule = placementLevel({ picture: s.picture?.result === 'named', readAccuracy: ['well', 'partly'].includes(s.read?.result) ? 1 : s.read?.accuracy ?? null, ratings: s.ratings });
    level = rule.level; by = "the app's rule";
    reasons = [`The AI gave no level, so the app's rule was used. ${rule.reasons.join(' ')}`];
    sum = said.length && ai ? await summarize({ answers: said, level, known }, { config: opts.summaryConfig || settings.get('placement').summary, structured: opts.structured, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
      : plainSummary({ answers: said, level, known });
    if (sum.meta) note('summary', { model: `${sum.meta.provider}/${sum.meta.model}`, ms: sum.meta.latencyMs, costInr: sum.meta.costInr ?? null, usage: sum.meta.usage });
  }
  const L = LEVELS[level];
  s.done = true;
  s.result = {
    level, name: L.name, blurb: L.blurb, hindi: L.hindi, overall: null, dims: {}, reasons, mode: 'conversation', decidedBy: by,
    doingWell: sum.doingWell, practise: sum.practise, picture: s.picture, read: s.read,
    answers: s.answers.map((a) => ({ q: a.questionId, level: a.variantLevel, skipped: a.skipped, transcript: a.transcript, ...(a.kind === 'open' ? { rated: a.rated, evidence: a.evidence, question: a.question, tip: a.tip } : { judged: a.judged, evidence: a.evidence }) })),
  };
  note('plan', { next: 'finish', level, name: L.name, decidedBy: by, why: reasons });
  // The level in fixed words; then what went well and what's next. Beginners hear the Hindi line too.
  const closing = [line(levelLine(level)), ...linesOf(clean(sum.closing, s.profile.name)), ...(level <= 2 ? [line(L.hindi, 0.95)] : [])];
  return respond(s, [...(spoken || linesOf(withoutQuestions(reply))), ...closing], [], { heard, done: s.result });
}

/** What the learner heard of Sakhi's last turn before talking over it (text), what they did not (rest), and whether they heard her question. */
function heardOf(s, { index = 0, heardSec = 0 }) {
  const { lines, askAt } = s.lastSay;
  const i = Math.max(0, Math.min(lines.length - 1, Number(index) || 0));
  const l = lines[i], total = speechSeconds(l.text, l) || l.text.length / 14; // about 14 characters a second
  const frac = Math.max(0, Math.min(1, (Number(heardSec) || 0) / total));
  let cut = l.text.slice(0, Math.round(l.text.length * frac));
  if (frac < 1) cut = cut.replace(/\s+\S*$/, '');
  const text = [...lines.slice(0, i).map((x) => x.text), cut].filter(Boolean).join(' ');
  const rest = [l.text.slice(cut.length).trim(), ...lines.slice(i + 1).map((x) => x.text)].filter(Boolean).join(' ');
  const askHeard = askAt >= lines.length ? true : i > askAt || (i === askAt && frac >= 0.6);
  return { index: i, cut, heard: text, text, rest, askHeard };
}
