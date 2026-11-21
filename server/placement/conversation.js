// The conversation placement (Settings › Placement test › mode "conversation"): the alternative to the classic
// five-part test in server/session.js, which stays as it is.
//
// A short talk of two to four questions. After each answer ONE AI call (brain.js) reacts to what the learner
// said, gives one gentle fix, rates the answer 1 to 4 and asks the next question. Code decides what comes next
// and the final level (level.js). The app sees the same reply shape as the classic test, so it needs no change:
//   { sessionId, say: [{text, lang, pace}], card: null, cue, listen, task, done? }
//
// If the AI is slow or fails, the talk carries on: a plain acknowledgement, a level from the words alone, and a
// reviewed question from the bank.
import { randomUUID } from 'node:crypto';
import { LEVELS, PHRASES } from '../../shared/assessment.js';
import { BANK } from '../../shared/bank.js';
import { voiceLanguage } from '../../shared/languages.js';
import { features } from '../scoring.js';
import { isUnintelligible } from '../clarify.js';
import { makeLedger } from '../costs.js';
import { speechSeconds } from '../sarvam.js';
import { stripInventedNames, fixContractions } from '../tutor.js';
import * as settings from '../settings.js';
import { think, summarize, tipIsTheirs } from './brain.js';
import { nextStep, placementLevel, missedLevel, clampLevel, WARM_UP } from './level.js';

const OPENING = {
  en: "Hi! I'm Sakhi. Let's chat for two minutes, so I can understand your English.",
  hi: 'नमस्ते! दो मिनट बात करते हैं, ताकि मैं आपकी अंग्रेज़ी समझ सकूँ। अंग्रेज़ी में बोलने की कोशिश कीजिए, थोड़े शब्द भी काफ़ी हैं।',
};
// The first thing she asks: closed, and not counted. Then an easy closed question, then they open up (level.js).
const HELLO = { en: "First, what's your name?", hi: 'सबसे पहले, आपका नाम क्या है?' };
const levelLine = (level) => `Thank you! Your English is at level ${level} of 4, ${LEVELS[level].name}.`;
const ACK = { en: 'Okay.', hi: 'ठीक है।' };
const INDIC = /[ऀ-ൿ]/;

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
    line(OPENING.en), line(OPENING.hi, 0.95), line(HELLO.en), line(HELLO.hi, 0.95),
    line(PHRASES.didntHear, 0.95), line(PHRASES.moveOn), line(ACK.en), line(ACK.hi, 0.95),
    ...[1, 2, 3, 4].map((l) => line(levelLine(l))), line(LEVELS[1].hindi, 0.95), line(LEVELS[2].hindi, 0.95),
  ];
}

// ---- the session -------------------------------------------------------------------------------------
export function startSession({ lab = false } = {}) {
  const s = {
    id: randomUUID(), mode: 'conversation', lab, at: Date.now(), history: [], answers: [], ratings: [],
    profile: { name: null, facts: [], language: null },
    q: { n: 0, hello: true, text: HELLO.en, target: WARM_UP, tries: 0, unheard: 0 },
    done: false, result: null, prev: null, ledger: makeLedger(),
  };
  sessions.set(s.id, s);
  return respond(s, [line(OPENING.en), line(OPENING.hi, 0.95)], [line(HELLO.en), line(HELLO.hi, 0.95)], { plan: 'opening' });
}

/** Say `before` (a reaction) and then `ask` (the question): the reply the app plays. */
function respond(s, before, ask = [], extra = {}) {
  const lines = [...before, ...ask];
  if (lines.length) s.lastSay = { lines, askAt: before.length, historyAt: s.history.length };
  for (const l of lines) s.history.push({ who: 'sakhi', text: l.text });
  return {
    sessionId: s.id, say: lines, card: null, cue: { line: ask.length ? before.length : Math.max(0, lines.length - 1), word: 0 }, learnerLanguage: null,
    listen: s.done ? null : { silenceMs: 1600, language: 'auto' },
    task: s.done ? null : { id: `c${s.q.n}`, level: s.q.target, kind: 'open', item: null },
    ...extra,
  };
}

/**
 * Everything the brain needs for this turn. Changes nothing, so the same turn can be given to several models
 * (the admin's model comparison).
 */
export function buildCtx(s, input) {
  const max = settings.get('placement').maxQuestions;
  // After the hello (not counted), whatever they said: the first counted question.
  const after = (level) => (s.q.hello ? { done: false, target: WARM_UP } : nextStep([...s.ratings, { level }], max));
  const f = input.event === 'answer' ? features(input.transcript, { speechSec: input.speechSec, kind: 'open', timing: input.timing }) : null;
  return {
    history: [...s.history], hello: !!s.q.hello, question: { text: s.q.text, target: s.q.target }, event: input.event, transcript: input.transcript || '',
    measured: f && { englishWords: f.englishWordCount, wpm: f.speechRate ?? f.wpm, longPauses: f.longPauses ?? 0 }, features: f,
    name: s.profile.name, afterLevel: { 1: after(1), 2: after(2), 3: after(3), 4: after(4) },
    // Skipped, or already helped twice: move on (the question counts as missed). Otherwise: help and ask again.
    notAnswered: input.event === 'skip' || s.q.tries >= (s.q.hello ? 1 : 2) ? { step: after(missedLevel(s.q.target)) } : { help: true },
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
  if (input.event === 'repeat') { note('plan', { next: 'the question again, slower' }); return respond(s, [], linesOf(s.q.text, 0.85)); }
  if (input.event === 'live_failed' || (input.event === 'answer' && isUnintelligible(input.transcript))) {
    if (++s.q.unheard <= 2) { note('plan', { next: 'ask again', why: `didn't hear an answer (${s.q.unheard} of 3)` }); return respond(s, [line(PHRASES.didntHear, 0.95)]); }
    note('plan', { next: 'move on', why: "couldn't hear an answer three times" });
    return advance(s, { ...buildCtx(s, { event: 'skip' }), event: 'skip' }, { answered: false, level: null, evidence: '', tip: null, name: null, reply: PHRASES.moveOn, question: '' }, input, note, opts);
  }

  // They talked over Sakhi before she reached her question: they were still finishing their last answer.
  // Go back to before that answer and take the two together as one.
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
  let out, meta = null;
  try {
    const t0 = performance.now();
    ({ out, meta } = await think(ctx, { config: opts.config || settings.get('placement').brain, structured: opts.structured }));
    note('brain', { model: `${meta.provider}/${meta.model}`, ms: Math.round(performance.now() - t0), costInr: meta.costInr ?? null, ...out });
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
  if (q.hello) {
    // The hello isn't an answer to rate: on to the first counted question.
    note('plan', { next: 'the first question', why: 'the hello is not counted' });
    const ask = question || bankQuestion(WARM_UP);
    s.q = { n: 1, text: ask, target: WARM_UP, tries: 0, unheard: 0 };
    return respond(s, linesOf(withoutQuestions(reply)), linesOf(ask), { heard });
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
  s.q = { n: q.n + 1, text: ask, target: step.target, tries: 0, unheard: 0 };
  return respond(s, linesOf(withoutQuestions(reply)), linesOf(ask), { heard });
}

async function finish(s, reply, heard, note, opts) {
  const { level, reasons } = placementLevel(s.ratings);
  const L = LEVELS[level];
  const said = s.answers.filter((a) => !a.skipped).map((a) => ({ transcript: a.transcript, level: a.rated, evidence: a.evidence, tip: a.tip }));
  const sum = await summarize({ answers: said, level }, { config: opts.summaryConfig || settings.get('placement').summary, structured: opts.structured });
  note('summary', { model: sum.meta ? `${sum.meta.provider}/${sum.meta.model}` : null, ms: sum.meta?.latencyMs ?? null, costInr: sum.meta?.costInr ?? null, closing: sum.closing, ...(sum.fallback ? { fallback: sum.fallback } : {}) });
  s.done = true;
  s.result = {
    level, name: L.name, blurb: L.blurb, hindi: L.hindi, overall: null, dims: {}, reasons, mode: 'conversation',
    doingWell: sum.doingWell, practise: sum.practise,
    answers: s.answers.map((a) => ({ q: a.questionId, level: a.variantLevel, skipped: a.skipped, transcript: a.transcript, rated: a.rated, evidence: a.evidence, question: a.question, tip: a.tip })),
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
