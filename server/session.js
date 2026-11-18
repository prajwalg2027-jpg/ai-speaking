// The placement conversation, run on the server: memory of what the learner said, the order of tasks,
// follow-up questions, the clarification steps, and the spoken summary at the end.
//
// The browser sends what happened in each turn (an answer, silence, a chip tap) and gets back what Sakhi
// says next, what to show, and how to listen. Sessions live in memory only (nothing is stored); they expire
// after two hours.
import { randomUUID } from 'node:crypto';
import { QUESTIONS, PHRASES, LEVELS, variantFor } from '../shared/assessment.js';
import { classifyTurn, measureAnswer, judgeAnswer } from './turn.js';
import { compose } from './tutor.js';
import { provisionalLevel, finalLevel } from './scoring.js';

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
    scripted: v.say, simple: v.simple, hindi: v.hindi, reference: q.kind === 'read' ? v.screen : null, expect: v.expect,
    tutor: q.tutor || v.tutor, card: showCard ? { text: v.screen, kind: q.kind === 'read' ? 'read' : 'task' } : null,
    probe, followUp: q.kind === 'open', ask: null,
  };
}

function makeFollowUp(parent) {
  return {
    id: `${parent.id}_followup`, kind: 'open', variantLevel: parent.variantLevel, silenceMs: parent.silenceMs, language: 'auto',
    scripted: PHRASES.followUp, simple: PHRASES.followUpSimple, hindi: PHRASES.followUpHindi, reference: null, expect: null, card: null,
    brief: 'Ask ONE natural follow-up question about something specific the learner just said, to get them talking more. Keep it easy to answer at their level.',
    tutor: { mustInclude: [], mustNotSay: [] }, followup: true, followUp: false, ask: null,
  };
}

const freshAttempt = () => ({ confusions: 0, unheard: 0, neededHindi: false, prior: '' });

/** Every scripted line the conversation can say, with the exact pace it's said at (for pre-generation). */
export function scriptedLines() {
  const out = [line(QUESTIONS[0].variants.any.say)];
  for (const q of QUESTIONS) for (const v of Object.values(q.variants)) {
    out.push(line(v.say), line(v.say, { pace: 0.8 }));
    if (v.simple) out.push(line(v.simple, { pace: 0.85 }));
    if (v.hindi) out.push(line(v.hindi, { pace: 0.9 }));
  }
  out.push(line(PHRASES.didntHear, { pace: 0.95 }), line(PHRASES.cutOff), line(PHRASES.moveOn), line(PHRASES.followUp),
    line(PHRASES.followUpSimple, { pace: 0.85 }), line(PHRASES.followUpHindi, { pace: 0.9 }), ...PHRASES.backchannels.map((b) => line(b)));
  return out;
}

// ---- session lifecycle ------------------------------------------------------------
export const getSession = (id) => sessions.get(id);

export function startSession() {
  const s = { id: randomUUID(), at: Date.now(), level: 2, qIndex: 0, history: [], answers: [], task: makeTask(0, 2), att: freshAttempt(), done: false };
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
      if (input.transcript) s.history.push({ who: 'learner', text: input.transcript, reading: t.kind === 'read' });
      const c = await classifyTurn({ task: t, transcript: input.transcript || '', speechSec: input.speechSec, prior: s.att.prior }, trace);
      if (c.action === 'didnt_hear') return didntHear(s, trace);
      if (c.action === 'cut_off') { s.att.prior = c.transcript; return respond(s, [line(PHRASES.cutOff)], { heard: c.transcript, plan: 'answer looks cut off: asking them to go on' }); }
      if (c.action === 'clarify') return clarify(s, c.intent, trace, c.transcript);
      return answered(s, { transcript: c.transcript, languageCode: input.languageCode, speechSec: input.speechSec || 0 }, trace);
    }
    default: throw Object.assign(new Error(`unknown event "${input.event}"`), { status: 400 });
  }
}

function clarify(s, intent, trace, heard) {
  const t = s.task, att = s.att;
  if (intent === 'skip' || intent === 'dont_know' || att.confusions >= 2) {
    trace.add('plan', { next: 'move on', why: intent === 'dont_know' ? "learner doesn't know" : 'third request for help' });
    return moveOn(s, trace);
  }
  att.confusions++;
  if (intent === 'in_hindi' || att.confusions === 2) {
    att.neededHindi = true;
    trace.add('plan', { next: 'simpler English, then Hindi', why: intent === 'in_hindi' ? 'learner asked for Hindi' : 'second request for help', countsAsNeedingHindi: true });
    return respond(s, [line(t.simple || t.ask, { pace: 0.85 }), line(t.hindi, { pace: 0.9 })], { heard });
  }
  trace.add('plan', { next: 'repeat more slowly', why: 'learner asked to repeat' });
  return respond(s, [line(t.ask, { pace: 0.8 })], { heard });
}

function didntHear(s, trace) {
  s.att.unheard++;
  if (s.att.unheard > 2) { trace.add('plan', { next: 'move on', why: "couldn't hear an answer three times" }); return moveOn(s, trace); }
  trace.add('plan', { next: 'ask again', why: `didn't hear an answer (${s.att.unheard} of 3)` });
  return respond(s, [line(PHRASES.didntHear, { pace: 0.95 })]);
}

function recordSkipped(s) {
  const t = s.task;
  if (t.followup || t.probe) return; // a missed follow-up or bonus sentence doesn't count against them
  s.answers.push({ questionId: t.id, kind: t.kind, variantLevel: t.variantLevel, skipped: true, neededHindi: s.att.neededHindi, features: {}, scores: { comprehension: 0, vocabulary: 0, grammar: 0, fluency: 0, pronunciation: 0, coherence: 0 } });
}

async function moveOn(s, trace) {
  recordSkipped(s);
  if (s.task.id === 'q1_intro') s.level = 1;
  return advance(s, nextMainTask(s), 'moved_on', trace);
}

async function answered(s, ans, trace) {
  const t = s.task;
  const measured = measureAnswer({ task: t, transcript: ans.transcript, speechSec: ans.speechSec }, trace);
  const entry = { questionId: t.id, kind: t.kind, variantLevel: t.variantLevel, skipped: false, neededHindi: s.att.neededHindi, transcript: ans.transcript, languageCode: ans.languageCode, features: measured.features };

  // Decide what comes next from instant measurements, so the tutor can write it while the answer is scored.
  let next, situation = t.kind === 'read' ? 'read_done' : 'answered';
  if (t.id === 'q1_intro') s.level = provisionalLevel(measured.features, measured.heuristic); // refined after scoring
  if (t.followUp) next = makeFollowUp(t);
  else if (t.id === 'q3_read' && !t.probe && measured.features.readAccuracy >= 0.95 && s.level < 4) { next = makeTask(2, s.level + 1, { probe: true }); situation = 'probe'; }
  else next = nextMainTask(s);
  trace.add('plan', { next: next === 'finish' ? 'finish' : next.followup ? 'follow-up question' : next.probe ? 'harder read-aloud sentence' : next.id });

  const judging = judgeAnswer({ task: t, transcript: ans.transcript, measured }, trace).then((j) => {
    Object.assign(entry, j);
    if (t.id === 'q1_intro') s.level = provisionalLevel(measured.features, j.scores);
  });

  if (t.probe) {
    // Bonus sentence: keep it only if it was read well; then the level goes up.
    const q3 = s.answers.findIndex((a) => a.questionId === 'q3_read');
    if (measured.features.readAccuracy >= 0.8 && q3 >= 0) { s.answers[q3] = entry; s.level = t.variantLevel; trace.add('plan', { level: s.level, why: 'harder sentence read well' }); }
  } else s.answers.push(entry);

  if (next === 'finish') { await judging; return finish(s, trace, ans.transcript); }
  // Score this answer and write Sakhi's next line at the same time.
  const [, turn] = await Promise.all([judging, advance(s, next, situation, trace, ans.transcript)]);
  return turn;
}

function nextMainTask(s) {
  const from = s.task.followup ? QUESTIONS.findIndex((q) => s.task.id === `${q.id}_followup`) : s.task.qIndex;
  const qIndex = from + 1;
  return qIndex >= QUESTIONS.length ? 'finish' : makeTask(qIndex, s.level);
}

async function advance(s, next, situation, trace, heard) {
  if (next === 'finish') return finish(s, trace, heard);
  // Main tasks use the latest level (Q1's full score is in by the time its follow-up is answered).
  if (!next.followup && !next.probe && next.qIndex != null) next = makeTask(next.qIndex, s.level);
  const said = await compose({ history: s.history, level: s.level, situation, task: next }, trace);
  next.ask = said.ask;
  s.task = next; s.att = freshAttempt();
  if (!next.followup && next.qIndex != null) s.qIndex = next.qIndex;
  return respond(s, [line(said.text)], { heard });
}

async function finish(s, trace, heard) {
  const result = finalLevel(s.answers);
  const L = LEVELS[result.level];
  const dims = Object.entries(result.dims || {}).sort((a, b) => b[1] - a[1]);
  const summaryTask = {
    id: 'summary', scripted: `You're a ${L.name} speaker! ${L.blurb}`, summary: { levelName: L.name },
    brief: `Close the conversation warmly in two or three short sentences. Tell them they're a "${L.name}" speaker (use exactly that name). Mention one specific strength from what they said${dims[0] ? ` (their strongest area was ${dims[0][0]})` : ''}, and one thing you'll work on together${dims.at(-1) ? ` (${dims.at(-1)[0]})` : ''}. No scores or numbers. Use their name if you know it.`,
    tutor: { mustInclude: [[L.name]], mustNotSay: [] },
  };
  const said = await compose({ history: s.history, level: result.level, situation: 'finish', task: summaryTask }, trace);
  s.done = true;
  s.result = { ...result, name: L.name, blurb: L.blurb, answers: s.answers.map((a) => ({ q: a.questionId, level: a.variantLevel, skipped: a.skipped, transcript: a.transcript, neededHindi: a.neededHindi })) };
  trace.add('plan', { next: 'finish', level: result.level, name: L.name });
  return respond(s, [line(said.text)], { heard, done: s.result });
}
