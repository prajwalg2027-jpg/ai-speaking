// Evaluating one learner turn:
//   quickCheck (instant) and understandTurn (LLM): is this an answer, a request, or something said to Sakhi?
//   measureAnswer (instant) + judgeAnswer (LLM): how good was the answer?
import * as sarvam from './sarvam.js';
import { detectClarification, isUnintelligible, looksTruncated } from './clarify.js';
import { features, heuristicScores, blend } from './scoring.js';
import { JUDGE_SYSTEM, judgeUser, UNDERSTAND_SYSTEM, CONTINUE_SYSTEM } from './prompts.js';
import { languageCode } from '../shared/languages.js';

/**
 * Instant checks before any LLM: unusable audio, a cut-off answer, or an obvious short request ("sorry, what?").
 * → { action: 'didnt_hear' | 'cut_off' | 'clarify', intent?, transcript } or { action: 'understand', transcript }
 */
export function quickCheck({ task, transcript, speechSec = 0, prior = '' }, trace) {
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
  const intent = detectClarification(transcript);
  if (intent) { trace.add('clarify', { intent, by: 'keyword match' }); return { action: 'clarify', intent, transcript }; }
  return { action: 'understand', transcript };
}

/**
 * What did the learner mean? An answer, a request, or something said to Sakhi instead of answering
 * (a correction, a complaint, a question). Also picks up what they tell us: their name (only if they say it),
 * facts about them, and whether they want to talk in Hindi.
 * asked: Sakhi's last line.
 * → { intent, english: 'yes'|'partly'|'no', language, name, facts }, or null if the model failed.
 * language: the language they asked Sakhi to talk in, as a code ("pa-IN", "en-IN"…), or its name if Sakhi can't speak it.
 */
export async function understandTurn({ asked, transcript, profile, heardOnly = null }, trace) {
  const meta = {};
  const user = [`Tutor asked: ${asked}`,
    heardOnly != null ? `NOTE: the learner talked over the tutor and heard only: "${heardOnly}" (not the question).` : '',
    `Known learner name: ${profile.name || 'unknown'}`, profile.facts?.length ? `Already known: ${profile.facts.join('; ')}` : '',
    `Learner replied: ${transcript}`].filter(Boolean).join('\n');
  const call = sarvam.chatJSON([{ role: 'system', content: UNDERSTAND_SYSTEM }, { role: 'user', content: user }], { temperature: 0, maxTokens: 160, meta, purpose: 'understand' });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('took over 4 s')), 4000));
  // The model sometimes writes "null" as text for an empty field: treat it (and "none", "unknown"…) as empty.
  const empty = (v) => (typeof v === 'string' && /^\s*(null|none|unknown|n\/a|-)?\s*$/i.test(v) ? null : v);
  const clean = (x) => x && { ...x, name: empty(x.name), language: empty(x.language) };
  const r = await trace.time('understand', () => Promise.race([call, timeout]).then(clean), (x) => ({ model: meta.model, ...x })).catch(() => null);
  if (!r) return null;
  const intents = ['answer', 'meta', 'language', 'repeat', 'slower', 'dont_know', 'skip', ...(heardOnly != null ? ['reply'] : [])];
  if (r.intent === 'in_hindi') Object.assign(r, { intent: 'language', language: r.language || 'Hindi' });
  // A long reply is an answer, whatever they had heard: never set it aside.
  if (r.intent === 'reply' && transcript.trim().split(/\s+/).length >= 12) r.intent = 'answer';
  const wantsLang = typeof r.language === 'string' && r.language.trim() ? r.language.trim() : null;
  let name = typeof r.name === 'string' && r.name.trim().length >= 2 && r.name.length <= 30 && !/^(null|none|unknown|n\/a)$/i.test(r.name.trim()) ? r.name.trim() : null;
  // A name must be in what they said ("my name is not Riya" is not a name), unless it was said in Hindi script.
  if (name && (new RegExp(`\\bnot\\s+${escapeRe(name)}\\b`, 'i').test(transcript)
    || (!/[\u0900-\u097F]/.test(transcript) && !transcript.toLowerCase().includes(name.toLowerCase())))) name = null;
  return {
    intent: intents.includes(r.intent) ? r.intent : 'answer',
    english: ['yes', 'partly', 'no'].includes(r.english) ? r.english : 'yes',
    language: wantsLang ? languageCode(wantsLang) || wantsLang : null,
    name,
    facts: Array.isArray(r.facts) ? r.facts.filter((f) => typeof f === 'string' && f.trim() && f.length <= 120).slice(0, 3) : [],
  };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The learner talked over Sakhi's reply: were they still finishing their previous answer? → true / false
 * heard: the part of Sakhi's reply they heard before talking over it.
 */
export async function continuesAnswer({ asked, previous, heard, transcript }, trace) {
  const meta = {};
  const user = `Tutor's question: ${asked}\nLearner's answer: ${previous}\nTutor then started saying (cut off here): ${heard || '(nothing yet)'}\nLearner then said: ${transcript}`;
  const call = sarvam.chatJSON([{ role: 'system', content: CONTINUE_SYSTEM }, { role: 'user', content: user }], { temperature: 0, maxTokens: 30, meta, purpose: 'understand' });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('took over 3 s')), 3000));
  const r = await trace.time('continues', () => Promise.race([call, timeout]), (x) => ({ model: meta.model, continues: x?.continues })).catch(() => null);
  return r?.continues === true;
}

/** Instant, deterministic measurements (no network). */
export function measureAnswer({ task, transcript, speechSec, timing }, trace) {
  const f = features(transcript, { speechSec, kind: task.kind, reference: task.reference, expect: task.expect, timing });
  const heur = heuristicScores(f, task.kind);
  trace.add('features', f);
  trace.add('heuristic', heur);
  return { features: f, heuristic: heur };
}

/** LLM rubric, blended with the measurements. */
export async function judgeAnswer({ task, transcript, measured }, trace) {
  const meta = {};
  const llm = await trace.time('judge', () => sarvam.chatJSON([{ role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: judgeUser({ question: task.ask, transcript, features: measured.features, kind: task.kind, reference: task.kind === 'read' ? task.reference : null,
      context: task.passage ? `Sentences the learner heard: ${task.passage}` : task.scene ? `The picture shows: ${task.scene}` : null }) }], { meta, purpose: 'scoring' }),
  (r) => ({ model: meta.model, scores: r, finish: meta.finish, usage: meta.usage })).catch(() => null);
  const scores = blend(llm, measured.heuristic);
  trace.add('scores', { task: task.id, blend: llm ? '60% LLM + 40% features' : 'features only', ...Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v == null ? null : +v.toFixed(2)])) });
  return { scores, llmNote: llm?.note ?? null };
}
