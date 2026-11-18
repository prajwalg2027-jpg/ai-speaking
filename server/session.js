// The placement conversation, run on the server: memory of the learner (what they said, their name, facts
// about them, whether they want Hindi), the order of tasks, follow-up questions, the clarification steps,
// and the spoken summary at the end.
//
// The browser sends what happened in each turn (an answer, silence, a chip tap) and gets back what Sakhi
// says next, what to show, and how to listen. Sessions live in memory only (nothing is stored); they expire
// after two hours.
import { randomUUID } from 'node:crypto';
import { QUESTIONS, PHRASES, LEVELS, variantFor } from '../shared/assessment.js';
import { quickCheck, understandTurn, measureAnswer, judgeAnswer } from './turn.js';
import { compose, sayable } from './tutor.js';
import { provisionalLevel, finalLevel } from './scoring.js';
import { makeLedger } from './costs.js';

const sessions = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [id, s] of sessions) if (now - s.at > TTL_MS) sessions.delete(id); }, 10 * 60 * 1000).unref();

const DEVANAGARI = /[ऀ-ॿ]/;
/** One spoken line. Lines with Hindi script use the Hindi voice setting (Bulbul reads mixed text). */
export const line = (text, { pace = 1 } = {}) => ({ text, lang: DEVANAGARI.test(text) ? 'hi-IN' : 'en-IN', pace });

// ---- tasks ----------------------------------------------------------------------
function makeTask(qIndex, level, { probe = false } = {}) {
  const q = QUESTIONS[qIndex];
  const v = variantFor(q, level);
  const showCard = q.kind === 'vocab' || q.kind === 'read' || (q.id === 'q4_opinion' && level <= 2);
  return {
    id: q.id, qIndex, kind: q.kind, variantLevel: q.variants.any ? level : Math.min(4, Math.max(1, level)),
    silenceMs: q.silenceMs, language: q.language || 'auto',
    scripted: v.say, simple: v.simple, hindi: v.hindi, reference: q.kind === 'read' ? v.screen : null, expect: v.expect, parts: v.parts,
    tutor: q.tutor || v.tutor, card: showCard ? { text: v.screen, kind: q.kind === 'read' ? 'read' : 'task' } : null,
    probe, followUp: q.kind === 'open', ask: null,
  };
}

function makeFollowUp(parent) {
  return {
    id: `${parent.id}_followup`, kind: 'open', variantLevel: parent.variantLevel, silenceMs: parent.silenceMs, language: 'auto',
    scripted: PHRASES.followUp, simple: PHRASES.followUpSimple, hindi: PHRASES.followUpHindi, reference: null, expect: null, card: null,
    brief: 'Ask ONE natural follow-up question about something specific the learner told you about their life, to get them talking more. Keep it easy to answer at their level.',
    tutor: { mustInclude: [], mustNotSay: [] }, followup: true, followUp: false, ask: null,
  };
}

/** The same task, narrowed to the parts the learner hasn't answered yet (`missing`: indexes into task.parts). */
function focusOn(t, missing) {
  const parts = missing.map((i) => t.parts[i]);
  return {
    ...t, focus: true,
    brief: `Ask ONLY for the part they haven't answered: ${parts.map((p) => p.what).join(', and ')}.`,
    tutor: { mustInclude: parts.flatMap((p) => p.mustInclude), mustNotSay: t.tutor?.mustNotSay || [] },
    scripted: parts.map((p) => p.say).join(' '), simple: parts.map((p) => p.say).join(' '), hindi: parts.map((p) => p.hindi).join(' '), ask: null,
  };
}

const freshAttempt = () => ({ confusions: 0, unheard: 0, meta: 0, neededHindi: false, prior: '', partial: null, askedRest: false, focus: null });

/** Every scripted line the conversation can say, with the exact pace it's said at (for pre-generation). */
export function scriptedLines() {
  const out = [line(QUESTIONS[0].variants.any.say)];
  for (const q of QUESTIONS) for (const v of Object.values(q.variants)) {
    out.push(line(v.say), line(v.say, { pace: 0.8 }));
    if (v.simple) out.push(line(v.simple, { pace: 0.85 }));
    if (v.hindi) out.push(line(v.hindi, { pace: 0.9 }));
    for (const p of v.parts || []) out.push(line(p.say), line(p.hindi));
  }
  out.push(line(PHRASES.didntHear, { pace: 0.95 }), line(PHRASES.cutOff), line(PHRASES.moveOn), line(PHRASES.followUp), line(PHRASES.hindiOk),
    line(PHRASES.followUpSimple, { pace: 0.85 }), line(PHRASES.followUpHindi, { pace: 0.9 }), ...PHRASES.backchannels.map((b) => line(b)));
  return out;
}

// ---- session lifecycle ------------------------------------------------------------
export const getSession = (id) => sessions.get(id);

export function startSession() {
  const s = {
    id: randomUUID(), at: Date.now(), level: 2, qIndex: 0, history: [], answers: [],
    // What the learner has told us. The name is only ever what they said (never guessed).
    profile: { name: null, facts: [], prefersHindi: false },
    task: makeTask(0, 2), att: freshAttempt(), done: false,
    ledger: makeLedger(), // Sarvam charges for this conversation (server/costs.js)
  };
  sessions.set(s.id, s);
  s.task.ask = s.task.scripted; // the opening line is the same for everyone (and cached)
  return respond(s, [line(s.task.ask)], { plan: 'opening' });
}

function respond(s, lines, extra = {}) {
  for (const l of lines) s.history.push({ who: 'sakhi', text: l.text });
  return {
    sessionId: s.id, say: lines, card: s.done ? null : s.task.card,
    listen: s.done ? null : { silenceMs: s.task.silenceMs, language: s.task.language },
    task: s.done ? null : { id: s.task.id, level: s.task.variantLevel, kind: s.task.kind },
    ...extra,
  };
}

/** What Sakhi is currently asking: the task, or just its missing part. */
const current = (s) => s.att.focus || s.task;

/**
 * Handle one learner turn.
 * input: { event: 'answer'|'no_speech'|'live_failed'|'skip'|'repeat'|'in_hindi', transcript?, languageCode?, speechSec? }
 */
export async function handleTurn(s, input, trace) {
  if (s.done) return respond(s, [], { done: s.result });
  s.at = Date.now();
  const t = s.task;
  switch (input.event) {
    case 'skip': trace.add('plan', { next: 'move on', why: 'learner tapped Skip' }); return moveOn(s, trace);
    case 'repeat': return clarify(s, 'repeat', trace);
    case 'in_hindi': return clarify(s, 'in_hindi', trace);
    case 'no_speech':
      // Silence usually means they're lost: offer the Hindi version, unless they've already had it.
      trace.add('check', { result: 'silence', why: 'no speech for 12 s' });
      return s.att.neededHindi ? moveOn(s, trace) : clarify(s, 'in_hindi', trace);
    case 'live_failed': return didntHear(s, trace);
    case 'answer': {
      const c = quickCheck({ task: t, transcript: input.transcript || '', speechSec: input.speechSec, prior: s.att.prior }, trace);
      if (c.action === 'didnt_hear') return didntHear(s, trace);
      s.history.push({ who: 'learner', text: input.transcript, reading: t.kind === 'read' });
      if (c.action === 'cut_off') { s.att.prior = c.transcript; return respond(s, [line(PHRASES.cutOff)], { heard: c.transcript, plan: 'answer looks cut off: asking them to go on' }); }
      if (c.action === 'clarify') return clarify(s, c.intent, trace, c.transcript);
      return understood(s, { transcript: c.transcript, languageCode: input.languageCode, speechSec: input.speechSec || 0 }, trace);
    }
    default: throw Object.assign(new Error(`unknown event "${input.event}"`), { status: 400 });
  }
}

/**
 * The learner said something that wasn't an obvious request for help. Usually it's an answer, so scoring and
 * Sakhi's next line start straight away, while an LLM reads the reply to check. If it wasn't an answer (a
 * correction, a complaint, a request to talk in Hindi…), or it was half of one, the prepared line is
 * dropped and Sakhi responds to what was actually said instead.
 */
async function understood(s, ans, trace) {
  const t = s.task, att = s.att;
  // After "and the other part?", score both replies together.
  const full = [att.partial?.transcript, ans.transcript].filter(Boolean).join(' ');
  const speechSec = (att.partial?.speechSec || 0) + ans.speechSec;
  const measured = measureAnswer({ task: t, transcript: full, speechSec }, trace);
  const level = levelAfter(s, measured);
  const notHit = missingParts(s, measured, full);
  const guess = planAfter(s, measured, notHit, level);

  // A real reading attempt doesn't need reading for meaning; anything else does.
  const reading = t.kind === 'read' && (measured.features.readAccuracy ?? 0) >= 0.5;
  const understanding = reading ? null : understandTurn({
    asked: current(s).ask, transcript: ans.transcript, profile: s.profile,
    parts: notHit.length ? t.parts.map((p) => p.what) : null,
  }, trace);
  let judging = guess.partial ? null : judgeAnswer({ task: t, transcript: full, measured }, trace);
  const drafting = guess.finish ? null : draft(s, guess, level, trace);
  drafting?.catch(() => {});

  const u = understanding ? await understanding : null;
  const hindiNow = u ? learn(s, u, trace) : false;
  const intent = u?.intent || 'answer';
  const dropped = (why) => trace.add('plan', { next: why, why: `the learner's reply was read as "${intent}"`, discarded: 'the prepared reply and scores' });

  if (intent === 'meta') { dropped('respond to what they said, then ask again'); return metaTurn(s, trace, ans.transcript); }
  if (intent === 'in_hindi') { dropped('switch to Hindi'); return clarify(s, 'in_hindi', trace, ans.transcript, { justAsked: hindiNow }); }
  if (intent === 'repeat' || intent === 'slower') { dropped('repeat more slowly'); return clarify(s, 'repeat', trace, ans.transcript); }
  const gaveUp = intent === 'dont_know' || intent === 'skip';
  if (gaveUp && !att.partial && !(measured.features.vocabHits || []).some(Boolean)) { dropped('move on'); return clarify(s, intent, trace, ans.transcript); }

  // An answer, or part of one. A part with cue words was decided above; for the others (naming the picture)
  // ask only if the reply check agrees they didn't try it.
  const missing = gaveUp ? [] : notHit.filter((i) => t.parts[i].cues || !u?.missing || u.missing.includes(i + 1));
  const same = missing.length === notHit.length && !hindiNow;
  const plan = same ? guess : planAfter(s, measured, missing, level);
  if (!same) trace.add('plan', { next: plan.partial ? 'ask for the missing part' : 'treat it as a full answer', why: hindiNow ? 'they asked for Hindi' : 'the reply check disagreed with the word match' });

  if (plan.partial) {
    const drafted = same ? await drafting : await draft(s, plan, level, trace);
    att.partial = { transcript: full, speechSec }; att.askedRest = true;
    const said = sayable(drafted.said, s.profile.name);
    att.focus = { ...drafted.next, ask: said.ask };
    trace.add('plan', { next: 'ask for the missing part', missing: missing.map((i) => t.parts[i].what) });
    return respond(s, [line(said.text)], { heard: ans.transcript });
  }

  // Record the answer.
  s.level = level;
  judging ||= judgeAnswer({ task: t, transcript: full, measured }, trace);
  const entry = { questionId: t.id, kind: t.kind, variantLevel: t.variantLevel, skipped: false, neededHindi: att.neededHindi, transcript: full, languageCode: ans.languageCode, features: measured.features };
  const scored = judging.then((j) => {
    Object.assign(entry, j);
    if (t.id === 'q1_intro') s.level = startLevel(s, provisionalLevel(measured.features, j.scores));
  });
  if (t.probe) {
    // Bonus sentence: keep it only if it was read well (the level went up in levelAfter).
    const q3 = s.answers.findIndex((a) => a.questionId === 'q3_read');
    if (measured.features.readAccuracy >= 0.8 && q3 >= 0) { s.answers[q3] = entry; trace.add('plan', { level, why: 'harder sentence read well' }); }
  } else s.answers.push(entry);

  if (plan.finish) { await scored; return finish(s, trace, full); }
  // Score this answer while Sakhi's next line is written (or finishes being written).
  const [, drafted] = await Promise.all([scored, same ? drafting : draft(s, plan, level, trace)]);
  return commit(s, drafted, full);
}

/** The level once this answer counts (the introduction sets it; a well-read bonus sentence raises it). */
function levelAfter(s, measured) {
  const t = s.task;
  if (t.id === 'q1_intro') return startLevel(s, provisionalLevel(measured.features, measured.heuristic)); // refined after scoring
  if (t.probe && measured.features.readAccuracy >= 0.8 && s.answers.some((a) => a.questionId === 'q3_read')) return t.variantLevel;
  return s.level;
}

/** A learner who asked to talk in Hindi starts on the easier tasks (a well-read bonus sentence can still raise the level). */
const startLevel = (s, level) => (s.profile.prefersHindi ? Math.min(2, level) : level);

/**
 * Word-task parts the learner may not have tried, if they got at least one right (a fully wrong answer isn't
 * half an answer). A part they named without the right answer ("library is… I forget") was tried.
 */
function missingParts(s, measured, transcript) {
  const t = s.task, hits = measured.features.vocabHits || [];
  if (t.kind !== 'vocab' || !t.parts || s.att.askedRest || !hits.some(Boolean)) return [];
  return hits.flatMap((h, i) => (h || mentions(transcript, t.parts[i].cues) ? [] : [i]));
}
const mentions = (text, cues = []) => cues.some((c) => (/[ऀ-ॿ]/.test(c) ? text.normalize('NFC').includes(c.normalize('NFC'))
  : new RegExp(`\\b${c}\\b`, 'i').test(text)));

/** What comes after an answer: { partial } | { finish } | { next, situation }. */
function planAfter(s, measured, missing, level) {
  const t = s.task;
  if (missing.length) return { partial: true, next: focusOn(t, missing), situation: 'partial' };
  const situation = t.kind === 'read' ? 'read_done' : t.kind === 'vocab' ? 'answered_task' : 'answered';
  if (t.followUp) return { next: makeFollowUp(t), situation };
  if (t.id === 'q3_read' && !t.probe && measured.features.readAccuracy >= 0.95 && level < 4) return { next: makeTask(2, level + 1, { probe: true }), situation: 'probe' };
  const qIndex = (t.followup ? QUESTIONS.findIndex((q) => t.id === `${q.id}_followup`) : t.qIndex) + 1;
  return qIndex >= QUESTIONS.length ? { finish: true } : { next: { qIndex }, situation };
}

/** Write Sakhi's line for a plan without changing the session (it may be thrown away). */
async function draft(s, plan, level, trace) {
  const next = plan.next.qIndex != null && !plan.next.id ? makeTask(plan.next.qIndex, level) : plan.next;
  const said = await compose({ history: s.history, level, profile: s.profile, situation: plan.situation, task: next }, trace);
  return { next, said };
}

/** Move to the drafted task and say its line. */
function commit(s, { next, said }, heard) {
  const out = sayable(said, s.profile.name);
  next.ask = out.ask;
  s.task = next; s.att = freshAttempt();
  // Asked in Hindi because the learner wanted Hindi: the task was given with Hindi help.
  if (s.profile.prefersHindi) s.att.neededHindi = true;
  if (!next.followup && next.qIndex != null) s.qIndex = next.qIndex;
  return respond(s, [line(out.text)], { heard });
}

/** Remember what the learner told us. Returns true if they just asked to talk in Hindi. */
function learn(s, u, trace) {
  const p = s.profile, before = JSON.stringify(p), wasHindi = p.prefersHindi;
  if (u.name) p.name = u.name;
  for (const f of u.facts) if (!p.facts.some((x) => x.toLowerCase() === f.toLowerCase())) p.facts.push(f);
  p.facts = p.facts.slice(-8);
  if (u.prefersHindi) p.prefersHindi = true;
  if (JSON.stringify(p) !== before) trace.add('profile', { ...p, facts: [...p.facts] });
  return !wasHindi && p.prefersHindi;
}

/** The learner said something to Sakhi instead of answering: respond to it, then ask the same thing again. */
async function metaTurn(s, trace, heard) {
  const att = s.att;
  if (++att.meta > 2) { trace.add('plan', { next: 'move on', why: 'third reply in a row that was not an answer' }); return moveOn(s, trace); }
  trace.add('plan', { next: 'respond to what they said, then ask the same thing again', why: 'the reply was not an answer' });
  const task = current(s);
  const said = sayable(await compose({ history: s.history, level: s.level, profile: s.profile, situation: 'meta', task }, trace), s.profile.name);
  task.ask = said.ask;
  return respond(s, [line(said.text)], { heard });
}

function clarify(s, intent, trace, heard, { justAsked = false } = {}) {
  const att = s.att, f = current(s);
  if (intent === 'skip' || intent === 'dont_know' || att.confusions >= 2) {
    trace.add('plan', { next: 'move on', why: intent === 'dont_know' ? "learner doesn't know" : intent === 'skip' ? 'learner asked to skip' : 'third request for help' });
    return moveOn(s, trace);
  }
  att.confusions++;
  if (intent === 'in_hindi' || att.confusions === 2) {
    att.neededHindi = true;
    trace.add('plan', { next: justAsked ? 'talk in Hindi from now on' : 'simpler English, then Hindi', why: intent === 'in_hindi' ? 'learner asked for Hindi' : 'second request for help', countsAsNeedingHindi: true });
    const lines = justAsked ? [line(PHRASES.hindiOk), line(f.hindi, { pace: 0.9 })] : [line(f.simple || f.ask, { pace: 0.85 }), line(f.hindi, { pace: 0.9 })];
    return respond(s, lines, { heard });
  }
  trace.add('plan', { next: 'repeat more slowly', why: 'learner asked to repeat' });
  return respond(s, [line(f.ask, { pace: 0.8 })], { heard });
}

function didntHear(s, trace) {
  s.att.unheard++;
  if (s.att.unheard > 2) { trace.add('plan', { next: 'move on', why: "couldn't hear an answer three times" }); return moveOn(s, trace); }
  trace.add('plan', { next: 'ask again', why: `didn't hear an answer (${s.att.unheard} of 3)` });
  return respond(s, [line(PHRASES.didntHear, { pace: 0.95 })]);
}

async function moveOn(s, trace) {
  const t = s.task;
  if (s.att.partial) {
    // They answered part of a two-part task: score that part rather than counting the task as skipped.
    const { transcript, speechSec } = s.att.partial;
    const measured = measureAnswer({ task: t, transcript, speechSec }, trace);
    const entry = { questionId: t.id, kind: t.kind, variantLevel: t.variantLevel, skipped: false, neededHindi: s.att.neededHindi, transcript, features: measured.features };
    s.answers.push(entry);
    Object.assign(entry, await judgeAnswer({ task: t, transcript, measured }, trace));
  } else if (!t.followup && !t.probe) {
    // A missed follow-up or bonus sentence doesn't count against them.
    s.answers.push({ questionId: t.id, kind: t.kind, variantLevel: t.variantLevel, skipped: true, neededHindi: s.att.neededHindi, features: {}, scores: { comprehension: 0, vocabulary: 0, grammar: 0, fluency: 0, pronunciation: 0, coherence: 0 } });
  }
  if (t.id === 'q1_intro') s.level = 1;
  const qIndex = (t.followup ? QUESTIONS.findIndex((q) => t.id === `${q.id}_followup`) : t.qIndex) + 1;
  if (qIndex >= QUESTIONS.length) return finish(s, trace);
  return commit(s, await draft(s, { next: { qIndex }, situation: 'moved_on' }, s.level, trace));
}

async function finish(s, trace, heard) {
  const result = finalLevel(s.answers);
  const L = LEVELS[result.level];
  const dims = Object.entries(result.dims || {}).sort((a, b) => b[1] - a[1]);
  const summaryTask = {
    id: 'summary', scripted: `You're a ${L.name} speaker! ${L.blurb}`, summary: { levelName: L.name },
    brief: `Close the conversation warmly in two or three short sentences. Tell them they're a "${L.name}" speaker (use exactly that name, in English). Mention one thing they told you about themselves (from ABOUT THE LEARNER), one strength${dims[0] ? ` (their strongest area was ${dims[0][0]})` : ''}, and one thing you'll work on together${dims.at(-1) ? ` (${dims.at(-1)[0]})` : ''}. No scores or numbers. Don't mention any misunderstanding or anything that went wrong.`,
    tutor: { mustInclude: [[L.name]], mustNotSay: [] },
  };
  const said = sayable(await compose({ history: s.history, level: result.level, profile: s.profile, situation: 'finish', task: summaryTask }, trace), s.profile.name);
  s.done = true;
  s.result = { ...result, name: L.name, blurb: L.blurb, answers: s.answers.map((a) => ({ q: a.questionId, level: a.variantLevel, skipped: a.skipped, transcript: a.transcript, neededHindi: a.neededHindi })) };
  trace.add('plan', { next: 'finish', level: result.level, name: L.name });
  return respond(s, [line(said.text)], { heard, done: s.result });
}
