// The conversation placement (Settings › Placement test › mode "conversation"): the alternative to the classic
// five-part test in server/session.js, which stays as it is.
//
// The talk goes from easy to hard (the whole rule is in level.js):
//   1. Hello     "Hi, my name is Sakhi. What is your name?"   (not counted)
//   2. Picture   "What is this called in English?"            (a picture on the screen)
//   3. Reading   one line on the screen, read out loud
//   4. Talking   open questions, only for those who named the picture or read the line
// Steps 1 to 3 need no AI: they are fixed lines, answered at once. In step 4, ONE AI call per answer (brain.js)
// reacts to what the learner said, gives one gentle fix, rates the answer 1 to 4 and asks the next question.
// The app sees the same reply shape as the classic test, so it needs no change:
//   { sessionId, say: [{text, lang, pace}], card, cue, listen, task, done? }
//
// If the AI is slow or fails, the talk carries on: a plain acknowledgement, a level from the words alone, and a
// reviewed question from the bank.
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
import { think, summarize, plainSummary, tipIsTheirs } from './brain.js';
import { nextStep, placementLevel, missedLevel, clampLevel, qualifies, READ_OK, OPEN_START } from './level.js';

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
    q: { step: 'hello', text: HELLO.en, tries: 0 },
    picture: null, read: null, // what the first two tasks showed (level.js)
    done: false, result: null, prev: null, ledger: makeLedger(),
  };
  sessions.set(s.id, s);
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

// ---- steps 1 to 3: hello, picture, reading (fixed lines, no AI) ------------------------------------------
const NOT_A_NAME = new Set('yes no hello hi sorry what okay ok namaste hindi english repeat again fine good here ready from not very happy the my name is am'.split(' '));
/** Their first name, only if they clearly said it ("My name is Ravi", "I am Ravi", or just "Ravi"). */
export function nameIn(t) {
  const cap = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
  const ok = (w) => w && /^[A-Za-z]{2,20}$/.test(w) && !NOT_A_NAME.has(w.toLowerCase());
  const m = t.match(/\b(?:my name is|my name's|name is|i am|i'm|this is|myself)\s+([A-Za-z]+)/i);
  if (m) return ok(m[1]) ? cap(m[1]) : null;
  const w = t.replace(/[.!,?]/g, ' ').trim().split(/\s+/);
  return w.length <= 2 && w.every(ok) ? cap(w[0]) : null;
}
const askAgain = (q) => (q.step === 'hello' ? [line(HELLO_AGAIN.en, 0.9), line(HELLO_AGAIN.hi, 0.9)]
  : q.step === 'picture' ? [line(q.v.simple || q.v.say, 0.9), line(q.v.hindi, 0.9)] : [line(READ.en, 0.9), line(READ.hi, 0.9)]);

function fixedStep(s, input, note, opts) {
  const q = s.q, t = (input.transcript || '').trim();
  const spoke = input.event === 'answer' && !isUnintelligible(t);
  const acc = q.step === 'read' && spoke ? readAccuracy(q.v.screen, t) : null;
  const asks = spoke && !(acc >= 0.3) ? detectClarification(t) : null; // "sorry?", "Hindi mein", "I don't know"…
  const gaveUp = input.event === 'skip' || asks === 'dont_know';
  const answered = spoke && !asks;
  if (spoke) s.history.push({ who: 'learner', text: t });
  const heard = spoke ? t : undefined;
  if (!answered && !gaveUp && q.tries < 1) {
    // Not an answer yet: once more, slower, with the Hindi (or "I couldn't hear that" if nothing came through).
    q.tries++;
    const unheard = input.event === 'live_failed' || (input.event === 'answer' && !spoke);
    note('plan', { next: 'the same step again', why: unheard ? "didn't hear an answer" : asks || input.event });
    return respond(s, unheard ? [line(PHRASES.didntHear, 0.95)] : [], askAgain(q), { heard });
  }
  const entry = { item: q.item || null, variantLevel: q.target ?? 1, neededHindi: q.tries > 0, languageCode: input.languageCode || null, skipped: !answered, transcript: spoke ? t : null };

  if (q.step === 'hello') {
    const name = answered ? nameIn(t) : null;
    if (name) s.profile.name = name;
    note('plan', { next: 'the picture', name });
    const v = pick(BANK.vocab[1], s.seed);
    s.q = { step: 'picture', v, item: v.id, text: v.say, target: 1, card: pictureCard(v), tries: 0 };
    return respond(s, [line(answered ? (name ? `Nice to meet you, ${name}!` : SAY.meet) : ACK.en)], [line(v.say), line(v.hindi, 0.95)], { heard });
  }

  if (q.step === 'picture') {
    const word = q.v.expect[0][0], hit = answered && vocabHits(t, [q.v.expect[0]])[0];
    s.picture = { hit, word };
    s.answers.push({ ...entry, questionId: 'picture', kind: 'vocab', features: { vocabHits: [hit] }, scores: { vocabulary: hit ? 4 : 0 } });
    note('picture', { word, named: hit, heard: t || null });
    // An everyday line for someone who knew the word; a very simple one otherwise.
    const level = hit ? 2 : 1, v = pick(BANK.read[level], s.seed);
    s.q = { step: 'read', v, item: v.id, text: READ.en, target: level, card: readCard(v), tries: 0 };
    const reply = hit ? SAY.yes : answered ? called(word) : `${SAY.noProblem} ${called(word)}`;
    return respond(s, [line(reply)], [line(READ.en), line(READ.hi, 0.95)], { heard });
  }

  // Reading.
  s.read = { accuracy: answered ? acc : null, level: q.target };
  s.answers.push({ ...entry, questionId: 'read', kind: 'read', features: { readAccuracy: answered ? acc : 0 }, scores: { pronunciation: answered ? +(acc * 4).toFixed(2) : 0 } });
  const go = qualifies({ picture: s.picture?.hit, readAccuracy: s.read.accuracy });
  note('read', { accuracy: s.read.accuracy, qualifies: go, why: go ? 'named the picture or read the line' : 'missed the picture and the reading' });
  const reply = answered ? SAY.thanks : PHRASES.moveOn;
  if (!go) return finish(s, reply, heard, note, opts);
  const open = pick(BANK.open, s.seed);
  s.q = { step: 'open', n: 1, text: open.simple, target: OPEN_START, tries: 0, unheard: 0 };
  return respond(s, [line(reply)], [line(open.simple), line(open.hindi, 0.95)], { heard });
}

// ---- step 4: open questions (one AI call per answer) ---------------------------------------------------
/**
 * Everything the brain needs for this turn. Changes nothing, so the same turn can be given to several models
 * (the admin's model comparison).
 */
export function buildCtx(s, input) {
  const max = settings.get('placement').maxQuestions;
  const after = (level) => nextStep([...s.ratings, { level }], max);
  const f = input.event === 'answer' ? features(input.transcript, { speechSec: input.speechSec, kind: 'open', timing: input.timing }) : null;
  return {
    history: [...s.history], question: { text: s.q.text, target: s.q.target }, event: input.event, transcript: input.transcript || '',
    measured: f && { englishWords: f.englishWordCount, wpm: f.speechRate ?? f.wpm, longPauses: f.longPauses ?? 0 }, features: f,
    name: s.profile.name, afterLevel: { 1: after(1), 2: after(2), 3: after(3), 4: after(4) },
    // Skipped, or already helped twice: move on (the question counts as missed). Otherwise: help and ask again.
    notAnswered: input.event === 'skip' || s.q.tries >= 2 ? { step: after(missedLevel(s.q.target)) } : { help: true },
  };
}

/** What Sakhi does when the AI gave nothing usable: acknowledge, and let the words alone give a level. */
function plainTurn(ctx) {
  const f = ctx.features;
  const level = !f ? null : f.englishWordCount < 3 ? 1 : f.englishWordCount < 12 ? 2 : 3;
  const hindi = f && (f.nonLatinRatio > 0.3 || f.englishWordCount < 3);
  return { answered: ctx.event === 'answer', level, evidence: 'The AI did not answer: level from the number of English words only.', tip: null, name: null, reply: hindi ? ACK.hi : ACK.en, question: '' };
}

/**
 * One learner turn.
 * input: { event: 'answer'|'no_speech'|'live_failed'|'skip'|'repeat'|'in_hindi', transcript?, languageCode?, speechSec?, timing?, interrupted? }
 * opts (tests and the model comparison): { config, summaryConfig, structured }
 */
export async function handleTurn(s, input, trace, opts = {}) {
  s.at = Date.now();
  const note = (step, data) => trace?.add(step, data);
  if (s.done) return respond(s, [], [], { done: s.result });
  if (!['answer', 'no_speech', 'live_failed', 'skip', 'repeat', 'in_hindi'].includes(input.event)) throw Object.assign(new Error(`unknown event "${input.event}"`), { status: 400 });
  if (input.event === 'repeat') { note('plan', { next: 'the question again, slower' }); return respond(s, [], s.q.step === 'open' ? linesOf(s.q.text, 0.85) : askAgain(s.q)); }
  if (s.q.step !== 'open') return fixedStep(s, input, note, opts);
  if (input.event === 'live_failed' || (input.event === 'answer' && isUnintelligible(input.transcript))) {
    if (++s.q.unheard <= 2) { note('plan', { next: 'ask again', why: `didn't hear an answer (${s.q.unheard} of 3)` }); return respond(s, [line(PHRASES.didntHear, 0.95)]); }
    note('plan', { next: 'move on', why: "couldn't hear an answer three times" });
    return advance(s, { ...buildCtx(s, { event: 'skip' }), event: 'skip' }, { answered: false, level: null, evidence: '', tip: null, name: null, reply: PHRASES.moveOn, question: '' }, input, note, opts);
  }

  // They talked over Sakhi before she reached her question: they were still finishing their last answer.
  // Go back to before that answer and take the two together as one.
  if (input.event === 'answer' && input.interrupted && s.lastSay) { // (open questions only: earlier steps returned above)
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
  let out, meta = null;
  try {
    const t0 = performance.now();
    ({ out, meta } = await think(ctx, { config: opts.config || settings.get('placement').brain, structured: opts.structured, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }));
    note('brain', { model: `${meta.provider}/${meta.model}`, ms: Math.round(performance.now() - t0), costInr: meta.costInr ?? null, usage: meta.usage, ...out });
  } catch (e) {
    note('brain-failed', { why: e.message, using: 'a plain acknowledgement and a reviewed question' });
    out = plainTurn(ctx);
  }
  s.lastMeta = meta;
  return advance(s, ctx, out, input, note, opts);
}

/** Apply the brain's turn: remember the answer, then help again, ask the next question, or finish. */
async function advance(s, ctx, out, input, note, opts) {
  const q = s.q, transcript = ctx.transcript.trim();
  const before = { ratings: s.ratings.length, answers: s.answers.length, history: s.history.length, q: { ...q }, transcript, speechSec: input.speechSec || 0 };
  if (transcript) s.history.push({ who: 'learner', text: transcript });
  // A name is only kept if they said it (in English letters it must be in their words).
  if (out.name && (INDIC.test(transcript) || transcript.toLowerCase().includes(out.name.toLowerCase()))) s.profile.name = out.name;
  const reply = clean(out.reply, s.profile.name), question = clean(out.question, s.profile.name);
  const heard = transcript || undefined;

  const answered = ctx.event === 'answer' && out.answered;
  if (!answered && ctx.notAnswered.help) {
    q.tries++;
    note('plan', { next: 'help, then the same question again', try: q.tries });
    return respond(s, linesOf(reply), linesOf(question || q.text, 0.9), { heard });
  }
  const f = ctx.features || {};
  const entry = { questionId: `c${q.n}`, item: null, kind: 'open', variantLevel: q.target, question: q.text, neededHindi: false, languageCode: input.languageCode || null };
  if (answered) {
    const level = clampLevel(out.level ?? plainTurn(ctx).level, f);
    const tip = tipIsTheirs(out.tip, transcript) ? out.tip : null;
    s.ratings.push({ level, target: q.target, englishWords: f.englishWordCount || 0 });
    s.answers.push({ ...entry, skipped: false, transcript, features: f, scores: { level }, rated: level, evidence: out.evidence, tip });
    s.prev = before;
    note('rated', { question: q.n, level, asked: q.target, englishWords: f.englishWordCount || 0, ...(level !== out.level ? { aiSaid: out.level } : {}) });
  } else {
    const level = missedLevel(q.target);
    s.ratings.push({ level, target: q.target, englishWords: 0, missed: true });
    s.answers.push({ ...entry, skipped: true, transcript: transcript || null, features: {}, scores: { level }, rated: level, evidence: "Couldn't answer this question.", tip: null });
    s.prev = null;
    note('rated', { question: q.n, level, asked: q.target, missed: true });
  }

  const step = nextStep(s.ratings, settings.get('placement').maxQuestions);
  if (step.done) return finish(s, withoutQuestions(reply), heard, note, opts);
  const ask = question || bankQuestion(step.target);
  if (!question) note('plan', { next: 'a reviewed question', why: 'the AI gave no question' });
  s.q = { step: 'open', n: q.n + 1, text: ask, target: step.target, tries: 0, unheard: 0 };
  return respond(s, linesOf(withoutQuestions(reply)), linesOf(ask), { heard });
}

async function finish(s, reply, heard, note, opts) {
  const { level, reasons } = placementLevel({ picture: s.picture?.hit, readAccuracy: s.read?.accuracy, ratings: s.ratings });
  const L = LEVELS[level];
  const said = s.answers.filter((a) => a.kind === 'open' && !a.skipped).map((a) => ({ transcript: a.transcript, level: a.rated, evidence: a.evidence, tip: a.tip }));
  // What the picture and the reading showed, in the learner's words.
  const known = [s.picture?.hit && `You know English words like '${s.picture.word}'.`, (s.read?.accuracy ?? 0) >= READ_OK && 'You can read an English sentence out loud.'].filter(Boolean);
  // The closing feedback is written from what they said in the open answers; without any, plain lines.
  const sum = said.length ? await summarize({ answers: said, level, known }, { config: opts.summaryConfig || settings.get('placement').summary, structured: opts.structured, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
    : plainSummary({ answers: [], level, known });
  note('summary', { model: sum.meta ? `${sum.meta.provider}/${sum.meta.model}` : null, ms: sum.meta?.latencyMs ?? null, costInr: sum.meta?.costInr ?? null, usage: sum.meta?.usage ?? null, closing: sum.closing, ...(sum.fallback ? { fallback: sum.fallback } : {}) });
  s.done = true;
  s.result = {
    level, name: L.name, blurb: L.blurb, hindi: L.hindi, overall: null, dims: {}, reasons, mode: 'conversation',
    doingWell: sum.doingWell, practise: sum.practise,
    picture: s.picture, read: s.read,
    answers: s.answers.map((a) => ({ q: a.questionId, level: a.variantLevel, skipped: a.skipped, transcript: a.transcript, ...(a.kind === 'open' ? { rated: a.rated, evidence: a.evidence, question: a.question, tip: a.tip } : {}) })),
  };
  note('plan', { next: 'finish', level, name: L.name, why: reasons });
  // The level in fixed words; then what went well and what's next. Beginners hear the Hindi line too.
  const closing = [line(levelLine(level)), ...linesOf(clean(sum.closing, s.profile.name)), ...(level <= 2 ? [line(L.hindi, 0.95)] : [])];
  return respond(s, [...linesOf(reply), ...closing], [], { heard, done: s.result });
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
