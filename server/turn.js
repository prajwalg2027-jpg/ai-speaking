// Evaluating one learner turn, in two steps so the tutor can prepare its reply while the answer is scored:
//   classifyTurn: is this an answer, a request for help, or nothing we could use?
//   measureAnswer (instant) + judgeAnswer (LLM): how good was it?
import * as sarvam from './sarvam.js';
import { detectClarification, isUnintelligible, looksTruncated } from './clarify.js';
import { features, heuristicScores, blend } from './scoring.js';
import { JUDGE_SYSTEM, judgeUser, INTENT_SYSTEM } from './prompts.js';

/** → { action: 'answer' | 'didnt_hear' | 'cut_off' | 'clarify', intent?, transcript } */
export async function classifyTurn({ task, transcript, speechSec = 0, prior = '' }, trace) {
  transcript = [prior, transcript].filter(Boolean).join(' ').trim();
  trace.add('question', { id: task.id, kind: task.kind, level: task.variantLevel, transcript, speechSec, ...(prior ? { joinedWithPrevious: prior } : {}) });

  if (isUnintelligible(transcript)) {
    trace.add('check', { result: "didn't hear", why: 'transcript is empty or under 2 letters' });
    return { action: 'didnt_hear', transcript };
  }
  if (looksTruncated(transcript, speechSec)) {
    trace.add('check', { result: 'cut off', why: 'short answer ending on a connecting word' });
    return { action: 'cut_off', transcript };
  }
  let intent = detectClarification(transcript);
  if (intent) trace.add('clarify', { intent, by: 'keyword match' });
  else if (transcript.split(/\s+/).length <= 4 && task.kind !== 'vocab') {
    // Ambiguous short reply: ask the LLM (skip for vocab, where 1-2 word answers are normal).
    const meta = {};
    intent = (await trace.time('intent', () => sarvam.chatJSON([{ role: 'system', content: INTENT_SYSTEM },
      { role: 'user', content: `Tutor asked: ${task.ask}\nLearner replied: ${transcript}` }], { temperature: 0, maxTokens: 30, meta }),
    (r) => ({ model: meta.model, result: r, usage: meta.usage })).catch(() => null))?.intent;
    if (intent === 'answer' || intent === 'off_topic') intent = null;
  } else {
    trace.add('clarify', { intent: null, by: 'keyword match', note: 'treated as an answer' });
  }
  return intent ? { action: 'clarify', intent, transcript } : { action: 'answer', transcript };
}

/** Instant, deterministic measurements (no network). */
export function measureAnswer({ task, transcript, speechSec }, trace) {
  const f = features(transcript, { speechSec, kind: task.kind, reference: task.reference, expect: task.expect });
  const heur = heuristicScores(f, task.kind);
  trace.add('features', f);
  trace.add('heuristic', heur);
  return { features: f, heuristic: heur };
}

/** LLM rubric, blended with the measurements. */
export async function judgeAnswer({ task, transcript, measured }, trace) {
  const meta = {};
  const llm = await trace.time('judge', () => sarvam.chatJSON([{ role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: judgeUser({ question: task.ask, transcript, features: measured.features, kind: task.kind, reference: task.kind === 'read' ? task.reference : null }) }], { meta }),
  (r) => ({ model: meta.model, scores: r, finish: meta.finish, usage: meta.usage })).catch(() => null);
  const scores = blend(llm, measured.heuristic);
  trace.add('scores', { task: task.id, blend: llm ? '60% LLM + 40% features' : 'features only', ...Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, +v.toFixed(2)])) });
  return { scores, llmNote: llm?.note ?? null };
}
