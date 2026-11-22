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
import { normalizeForCompare } from '../normalize.js';
import { think, summarize, plainSummary, usableFinal, tipIsTheirs, learnerLine } from './brain.js';
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
    done: false, result: null, prev: null, ledger: makeLedger(),
  };
  sessions.set(s.id, s);
  // The opening is the one fixed line: there is nothing to respond to yet.
  return respond(s, [], [line(HELLO.en), line(HELLO.hi, 0.95)], { plan: 'opening' });
}

/** Say `before` (a reaction) and then `ask` (the question): the reply the app plays. */
function respond(s, before, ask = [], extra = {}) {
  const lines = [...before, ...ask], q = s.q;
  if (lines.length) s.lastSay = { lines, askAt: before.length, historyAt: s.history.length };
  for (const l of lines) s.history.push({ who: 'sakhi', text: l.text });
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
 * Everything the AI needs for this turn: the talk so far, and the facts and choices for its note (brain.js).
 * Changes nothing.
 */
export function buildCtx(s, input) {
  const q = s.q, t = (input.transcript || '').trim(), max = settings.get('placement').maxQuestions;
  const spoke = input.event === 'answer' && !isUnintelligible(t);
  const f = spoke ? features(t, { speechSec: input.speechSec, kind: 'open', timing: input.timing }) : null;
  const facts = [], sofar = [];
  if (!spoke) facts.push({ no_speech: 'They said nothing.', in_hindi: 'They tapped "in Hindi": they want it in Hindi.', skip: 'They tapped "skip".' }[input.event] || 'Their reply could not be heard.');
  let hit = null, acc = null, onward, mustFinish = false;
  if (q.step === 'hello') {
    onward = 'greet them, then lead into the picture: tell them a picture is on their screen and ask what it is called in English. (You will be told what the picture is next turn.)';
  } else if (q.step === 'picture') {
    const words = q.v.expect[0];
    hit = spoke && vocabHits(t, [words])[0];
    facts.push(`The picture on their screen shows: ${words[0]}${words.length > 1 ? ` (also right: ${words.slice(1).join(', ')})` : ''}.`);
    if (spoke) facts.push(`The app's check: "${words[0]}" is ${hit ? '' : 'not '}in their reply.`);
    onward = 'lead into the reading: tell them a line of English is on their screen and ask them to read it out loud. (You will be told the line next turn.)';
  } else if (q.step === 'read') {
    acc = spoke ? readAccuracy(q.v.screen, t) : 0;
    const total = q.v.screen.split(/\s+/).length;
    facts.push(`The line on their screen (NEVER say it): "${q.v.screen}"`);
    if (spoke) facts.push(`The app matched about ${Math.round(acc * total)} of its ${total} words in their reply.`);
    onward = `decide whether they can go on. If yes: ask your first open question, about their everyday life (you may ask up to ${max}). If no: finish.`;
  } else {
    if (f) facts.push(`They spoke ${f.englishWordCount} English words in this reply.`);
    const left = max - q.n;
    mustFinish = left <= 0;
    onward = mustFinish ? 'this was the last question. Finish now.' : `either ask one more open question (you may ask ${left} more) or finish, if you are sure of their level.`;
    if (s.ratings.length) sofar.push(`Earlier open answers: ${s.ratings.map((r) => (r.missed ? 'one not answered' : `level ${r.level} (${r.englishWords} English words)`)).join(', ')}.`);
  }
  if (s.picture) sofar.unshift(`Picture: ${s.picture.result.replace('_', ' ')}.`);
  if (s.read) sofar.splice(s.picture ? 1 : 0, 0, `Reading: ${s.read.result === 'skipped' ? 'skipped' : `read ${s.read.result === 'not' ? 'little or none of it' : s.read.result}`}.`);
  return {
    history: [...s.history], step: q.step, n: q.n, event: input.event, transcript: t, facts, sofar, name: s.profile.name, onward, mustFinish,
    // How often she may stay on one step: twice for help, once for something off the point.
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
 * opts (tests and the model comparison): { config, summaryConfig, structured, timeoutMs, detail }
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
    return respond(s, [], s.lastSay?.askAt < s.lastSay?.lines.length ? s.lastSay.lines.slice(s.lastSay.askAt).map((l) => ({ ...l, pace: Math.min(l.pace, 0.85) })) : fixedAsk(s.q, true));
  }

  // They talked over Sakhi before she reached her question (open questions): they were still finishing their
  // last answer. Go back to before that answer and take the two together as one.
  if (input.event === 'answer' && input.interrupted && s.lastSay) {
    const heard = heardOf(s, input.interrupted);
    if (!heard.askHeard && s.prev) {
      const p = s.prev;
      note('interrupted', { heard: heard.text, next: 'join it to their previous answer' });
      s.ratings.length = p.ratings; s.answers.length = p.answers; s.history.length = p.history; s.q = { ...p.q }; s.prev = null;
      input = { ...input, interrupted: null, transcript: `${p.transcript} ${input.transcript}`.trim(), speechSec: (p.speechSec || 0) + (input.speechSec || 0), timing: null };
    } else {
      // Keep only what they heard in the memory of the talk.
      const at = s.lastSay.historyAt + heard.index;
      if (s.history[at]?.who === 'sakhi') s.history.splice(at, s.lastSay.lines.length - heard.index, { who: 'sakhi', text: `${heard.cut || '…'} [the learner talked over Sakhi here]` });
      note('interrupted', { heard: heard.text, askHeard: heard.askHeard });
    }
  }

  const ctx = buildCtx(s, input);
  let out, ai = true;
  try {
    const t0 = performance.now();
    const r = await think(ctx, { config: opts.config || settings.get('placement').brain, structured: opts.structured, wantThinking: !!opts.detail, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    out = r.out;
    // The whole request and the answer as it came, only where someone will read them (the model comparison).
    if (opts.detail) note('exchange', { messages: r.messages, raw: r.meta.raw ?? null, thinking: r.meta.thinking ?? null, attempts: r.meta.attempts });
    note('brain', { model: `${r.meta.provider}/${r.meta.model}`, ms: Math.round(performance.now() - t0), costInr: r.meta.costInr ?? null, usage: r.meta.usage, at: ctx.step, ...out });
  } catch (e) {
    note('brain-failed', { why: e.message, using: "the app's own checks and fixed lines" });
    out = plainTurn(s, ctx); ai = false;
  }
  return advance(s, ctx, out, input, note, opts, ai);
}

/** Apply the AI's turn: remember what it judged, then stay on the step, move to the next, or finish. */
async function advance(s, ctx, out, input, note, opts, ai) {
  const q = s.q, transcript = ctx.transcript;
  const before = { ratings: s.ratings.length, answers: s.answers.length, history: s.history.length, q: { ...q }, transcript, speechSec: input.speechSec || 0 };
  s.history.push({ who: 'learner', text: learnerLine(ctx.spoke ? 'answer' : input.event === 'answer' ? 'live_failed' : input.event, transcript) });
  // A name is only kept if they said it (in English letters it must be in their words).
  if (out.name && ctx.spoke && (INDIC.test(transcript) || transcript.toLowerCase().includes(out.name.toLowerCase()))) s.profile.name = out.name;
  let reply = clean(out.reply, s.profile.name), question = clean(out.question, s.profile.name);
  const heard = ctx.spoke ? transcript : undefined;
  const h = ctx.spoke || out.happened !== 'answered' ? out.happened : 'asked_for_help'; // nothing was said: it can't be an answer

  // Stay on the step: help (twice at most) or a steer back (once).
  if ((h === 'asked_for_help' && ctx.stayFor.asked_for_help) || (h === 'something_else' && ctx.stayFor.something_else)) {
    if (h === 'asked_for_help') q.helps++; else q.steers++;
    note('plan', { next: 'the same step again', why: h, helps: q.helps, steers: q.steers });
    ({ reply, question } = safeToSay(q, reply, question, note));
    return respond(s, linesOf(reply), question ? linesOf(question, 0.95) : fixedAsk(q, true), { heard });
  }
  const answered = h === 'answered', skipped = h === 'could_not';
  const entry = { item: q.item || null, variantLevel: q.target ?? 1, neededHindi: q.helps > 0, languageCode: input.languageCode || null, skipped: !answered, transcript: ctx.spoke ? transcript : null };
  let next;

  if (q.step === 'hello') {
    const v = pick(BANK.vocab[1], s.seed);
    next = { step: 'picture', v, item: v.id, text: v.say, target: 1, card: pictureCard(v), helps: 0, steers: 0 };
  } else if (q.step === 'picture') {
    const result = answered ? (out.picture || (ctx.hit ? 'named' : 'not_named')) : skipped ? 'skipped' : 'not_named';
    s.picture = { result, word: q.v.expect[0][0] };
    s.answers.push({ ...entry, questionId: 'picture', kind: 'vocab', features: { vocabHits: [!!ctx.hit] }, scores: { vocabulary: result === 'named' ? 4 : 0 }, judged: result, evidence: out.evidence });
    note('judged', { on: 'picture', result, appCheck: ctx.hit });
    // An everyday line for someone who knew the word; a very simple one otherwise.
    const level = result === 'named' ? 2 : 1, v = pick(BANK.read[level], s.seed);
    next = { step: 'read', v, item: v.id, text: READ.en, target: level, card: readCard(v), helps: 0, steers: 0 };
  } else if (q.step === 'read') {
    const result = answered ? (out.reading || READ_RESULT(ctx.accuracy)) : skipped ? 'skipped' : 'not';
    s.read = { result, accuracy: ctx.spoke ? ctx.accuracy : null, level: q.target };
    s.answers.push({ ...entry, questionId: 'read', kind: 'read', features: { readAccuracy: ctx.accuracy || 0 }, scores: { pronunciation: +((ctx.accuracy || 0) * 4).toFixed(2) }, judged: result, evidence: out.evidence });
    note('judged', { on: 'reading', result, appMatched: ctx.accuracy });
    if (out.finish) return finish(s, reply, out.final, heard, note, opts, ai);
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
      note('judged', { on: `open question ${q.n}`, level, englishWords: f.englishWordCount || 0 });
    } else {
      s.ratings.push({ level: missedLevel(q.target), target: q.target, englishWords: 0, missed: true });
      s.answers.push({ ...entry, questionId: `c${q.n}`, kind: 'open', question: q.text, features: {}, scores: {}, rated: null, evidence: out.evidence || "Didn't answer this question.", tip: null });
      s.prev = null;
      note('judged', { on: `open question ${q.n}`, missed: true, why: h });
    }
    if (out.finish || ctx.mustFinish) return finish(s, reply, out.final, heard, note, opts, ai);
    const target = Math.min(4, (s.ratings.at(-1).level || 2) + 1);
    next = { step: 'open', n: q.n + 1, text: question || bankQuestion(target), target, helps: 0, steers: 0 };
  }

  s.q = next;
  ({ reply, question } = safeToSay(next, reply, question, note, q));
  const ask = question ? linesOf(question) : next.fixed || fixedAsk(next);
  if (!question) note('plan', { next: 'a fixed line', why: ai ? 'the AI gave no usable line' : 'the AI did not answer' });
  return respond(s, linesOf(withoutQuestions(reply)), ask, { heard });
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
async function finish(s, reply, final, heard, note, opts, ai) {
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
  return respond(s, [...linesOf(withoutQuestions(reply)), ...closing], [], { heard, done: s.result });
}

/** What the learner heard of Sakhi's last turn before talking over it, and whether that included her question. */
function heardOf(s, { index = 0, heardSec = 0 }) {
  const { lines, askAt } = s.lastSay;
  const i = Math.max(0, Math.min(lines.length - 1, Number(index) || 0));
  const l = lines[i], total = speechSeconds(l.text, l) || l.text.length / 14; // about 14 characters a second
  const frac = Math.max(0, Math.min(1, (Number(heardSec) || 0) / total));
  let cut = l.text.slice(0, Math.round(l.text.length * frac));
  if (frac < 1) cut = cut.replace(/\s+\S*$/, '');
  const text = [...lines.slice(0, i).map((x) => x.text), cut].filter(Boolean).join(' ');
  const askHeard = askAt >= lines.length ? true : i > askAt || (i === askAt && frac >= 0.6);
  return { index: i, cut, text, askHeard };
}
