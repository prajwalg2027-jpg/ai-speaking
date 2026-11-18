// The tutor: writes what Sakhi says between tasks, so the placement feels like a conversation.
//
// The assessment tasks stay fixed (what's measured, the words, the difficulty). Sarvam-105B (the
// conversations variant) only writes the wrapper: a reaction to what the learner just said, a bridge, and the
// task in natural words. Every line is checked before Sakhi says it; if a check fails, the scripted line is used.
import * as sarvam from './sarvam.js';
import { config } from './config.js';
import { normalizeForCompare } from './normalize.js';

export const TUTOR_SYSTEM = `You are Sakhi, a warm and encouraging English tutor in a voice app for learners in India. You are having a friendly spoken conversation. Inside it you are quietly checking the learner's English level, but you never mention tests, levels, scores, questions or how many are left.

Write what Sakhi says next as JSON: {"reaction": "...", "ask": "..."}
- reaction: one short sentence reacting to what the learner just said. Make it specific and personal: use their name or a detail they shared. Warm and natural. React to WHAT they said, never to HOW WELL they said it: no corrections and no verdicts ("perfect", "correct", "exactly", "well said", "good grammar", "your English is"). Never ask a question here. Use "" when there is nothing to react to.
- ask: what Sakhi says next to move the conversation on, ending with the TASK. Connect it naturally to what they said when you can. One to three short sentences.
Speak like a person: short sentences, contractions, everyday words. No lists, no emojis, no markdown, nothing hard to say out loud.
Follow LANGUAGE exactly. Never say anything on the MUST NOT SAY list, and never give away the answer to the task.`;

const LANGUAGE_RULES = {
  1: 'The learner is a beginner. Use very simple, short English with common words. Then add ONE short sentence in Hindi (Devanagari script) that restates the task simply, in the polite आप form (बताइए, पढ़िए, कीजिए; never बताओ). The Hindi must not give away the answer either. Keep the key task words in English.',
  2: 'The learner knows some English. Use simple, clear English. You may add a Hindi word or two only if the learner used Hindi.',
  3: 'The learner speaks English comfortably. Use natural, friendly English. No Hindi.',
  4: 'The learner is very fluent. Use natural, rich English; you can be a little playful. No Hindi.',
};

const SITUATIONS = {
  answered: 'The learner just answered.',
  moved_on: "The learner couldn't answer the last task, or asked to skip it. Be kind and reassuring; don't dwell on it.",
  probe: 'The learner just read a sentence from the screen (not their own words). The reaction is only a brief thanks, nothing about earlier topics. Ask them to try one more sentence, now on their screen. Do not say how well they read.',
  read_done: "The learner just read a sentence aloud from the screen. Those were not their own words. The reaction is only a brief thanks (like \"Thank you, Priya.\"), nothing about the sentence or earlier topics.",
  finish: 'The conversation is ending.',
};

// Sakhi stays warm about what was said, never about how well it was said: no corrections, no verdicts.
// Any sentence (in the reaction or the task line) that matches is dropped before Sakhi speaks.
const CORRECTION = /\b(should (?:say|be)|correct(?:ly|ion)?|mistakes?|wrong|grammar|instead of|you meant|the right word|right answer|perfect(?:ly)?|exactly( right)?|spot on|well said|well done|did (?:very |really )?well|great (?:job|answer|reading)|good (?:job|answer|reading)|know (?:those|these|the|so many|a lot of|many) (?:english )?words|(?:so|very|really) well|excellent|nailed|clearly|fluen(?:t|cy)|good english|your english|pronunciation|accent)\b/i;
const sentences = (t) => t.match(/[^.!?।]+[.!?।]*\s*/g) || [t];
export const stripVerdicts = (t) => sentences(t || '').filter((s) => !CORRECTION.test(s)).join('').trim();
const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const has = (text, needle) => text.toLowerCase().normalize('NFKC').includes(needle.toLowerCase().normalize('NFKC'));

/** Does a proposed task line keep the task intact? → { ok, reason } */
export function checkAsk(ask, task) {
  if (!ask || !ask.trim()) return { ok: false, reason: 'empty' };
  if (words(ask) > 70) return { ok: false, reason: 'too long' };
  const spec = task.tutor || {};
  for (const group of spec.mustInclude || []) {
    if (!group.some((w) => has(ask, w))) return { ok: false, reason: `missing "${group[0]}"` };
  }
  for (const w of spec.mustNotSay || []) {
    if (has(ask, w)) return { ok: false, reason: `gives away "${w}"` };
  }
  if (task.reference) {
    // Read-aloud: Sakhi must not say the sentence (no run of 4 of its words).
    const ref = normalizeForCompare(task.reference), said = ` ${normalizeForCompare(ask).join(' ')} `;
    for (let i = 0; i + 4 <= ref.length; i++) if (said.includes(` ${ref.slice(i, i + 4).join(' ')} `)) return { ok: false, reason: 'reads the sentence out' };
  }
  if (task.followup && !ask.includes('?')) return { ok: false, reason: 'follow-up is not a question' };
  if (task.summary && !has(ask, task.summary.levelName)) return { ok: false, reason: 'summary lacks the level name' };
  return { ok: true };
}

/** A reaction is optional; drop it if it corrects, evaluates, asks or rambles. */
export function checkReaction(reaction) {
  const r = stripVerdicts(reaction);
  if (!r) return '';
  if (words(r) > 30 || r.includes('?')) return '';
  return r;
}

function historyText(history) {
  return history.slice(-8).map((h) => (h.who === 'sakhi' ? `Sakhi: ${h.text}`
    : h.reading ? `Learner (reading a sentence from the screen, not their own words): ${h.text}` : `Learner: ${h.text}`)).join('\n') || '(nothing yet)';
}

/**
 * Write Sakhi's next line. → { text, reaction, ask, fallback?: reason }
 * task: { brief | tutor.brief, tutor: { mustInclude, mustNotSay }, scripted, reference?, followup?, summary? }
 */
export async function compose({ history, level, situation, task }, trace) {
  const spec = task.tutor || {};
  const quote = (w) => `"${w}"`;
  const user = [
    `LEARNER LEVEL: ${level} of 4 (1 = beginner, 4 = very fluent)`,
    `LANGUAGE: ${LANGUAGE_RULES[level] || LANGUAGE_RULES[2]}`,
    `CONVERSATION SO FAR:\n${historyText(history)}`,
    `WHAT JUST HAPPENED: ${SITUATIONS[situation] || SITUATIONS.answered}`,
    `TASK: ${task.brief || spec.brief}`,
    spec.mustInclude?.length ? `MUST INCLUDE (from each group, use at least one of these exact words, naturally): ${spec.mustInclude.map((g) => g.map(quote).join(' or ')).join('; ')}` : '',
    spec.mustNotSay?.length ? `MUST NOT SAY: ${spec.mustNotSay.map(quote).join(', ')}` : '',
    task.reference ? 'The sentence is on their screen. Do not say any part of it.' : '',
  ].filter(Boolean).join('\n');

  const meta = {};
  let out = null;
  try {
    // A slow reply is worse than a scripted one: give the model 4 s.
    const reply = sarvam.chatJSON([{ role: 'system', content: TUTOR_SYSTEM }, { role: 'user', content: user }],
      { model: config.sarvam.llmReplyModel, temperature: 0.7, maxTokens: 300, meta });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('tutor took over 4 s')), 4000));
    out = await trace.time('tutor', () => Promise.race([reply, timeout]),
      (r) => ({ model: meta.model, situation, task: task.id, reaction: r?.reaction, ask: r?.ask, usage: meta.usage }));
  } catch { /* fall back below */ }

  const reaction = checkReaction(out?.reaction);
  // The closing summary is allowed to say how they did; every other line isn't.
  const proposed = task.summary ? (out?.ask || '').trim() : stripVerdicts(out?.ask);
  const check = checkAsk(proposed, task);
  const ask = check.ok ? proposed : task.scripted;
  if (!check.ok) trace.add('tutor-fallback', { task: task.id, reason: out ? check.reason : 'no reply from the model', using: 'scripted line' });
  return { text: [reaction, ask].filter(Boolean).join(' '), reaction, ask, ...(check.ok ? {} : { fallback: out ? check.reason : 'no reply' }) };
}
