// The tutor: writes what Sakhi says between tasks, so the placement feels like a conversation.
//
// The assessment tasks stay fixed (what's measured, the words, the difficulty). Sarvam-105B (the
// conversations variant) only writes the wrapper: a reaction to what the learner just said, a bridge, and the
// task in natural words. Every line is checked before Sakhi says it; if a check fails, the scripted line is used.
import * as sarvam from './sarvam.js';
import { config } from './config.js';
import { normalizeForCompare } from './normalize.js';
import { LANGUAGES } from '../shared/languages.js';

export const TUTOR_SYSTEM = `You are Sakhi, a warm and encouraging English tutor in a voice app for learners in India. You are having a friendly spoken conversation. Inside it you are quietly checking the learner's English level, but you never mention tests, levels, scores, questions or how many are left.

Write what Sakhi says next as JSON: {"reaction": "...", "ask": "..."}
- reaction: one short sentence reacting to the learner's LAST line only. Warm and natural; you can pick up a detail from that line. Don't bring back details from earlier in the conversation. React to WHAT they said, never to HOW WELL they said it: no corrections and no verdicts ("perfect", "correct", "exactly", "well said", "good grammar", "your English is"). Never ask a question here. Use "" when there is nothing to react to.
- ask: what Sakhi says next to move the conversation on, ending with what the TASK below asks for (never say the word "task"). Connect it naturally to what they said when you can. One to three short sentences. Ask exactly one question, never two at once (no "and also…"). Don't teach, explain or introduce words.
Names: use the learner's name only if it is given under ABOUT THE LEARNER, and only now and then. If no name is given there, don't use any name, and never guess or invent one. Names in a sentence they read from the screen are not their name.
Speak like a person: short sentences, contractions, everyday words. No lists, no emojis, no markdown, nothing hard to say out loud.
Follow LANGUAGE exactly. Never say anything on the MUST NOT SAY list, and never give away the answer to the task.`;

const LANGUAGE_RULES = {
  1: 'The learner is a beginner. Use very simple, short English with common words. Then add ONE short sentence in Hindi (Devanagari script) that restates the task simply, in the polite आप form (बताइए, पढ़िए, कीजिए; never बताओ). The Hindi must not give away the answer either. Keep the key task words in English.',
  2: 'The learner knows some English. Use simple, clear English. You may add a Hindi word or two only if the learner used Hindi.',
  3: 'The learner speaks English comfortably. Use natural, friendly English. No Hindi.',
  4: 'The learner is very fluent. Use natural, rich English; you can be a little playful. No Hindi.',
};
// The learner asked to talk in another language: this replaces the level rule for the rest of the conversation.
const HINDI_RULE = 'The learner asked to talk in Hindi. Speak in simple, friendly Hindi (Devanagari script, the polite आप form: बताइए, पढ़िए, कीजिए; never बताओ). Keep the task\'s key words in English, exactly as given. When the task is to talk about something, invite them to try it in English (Hindi is fine too). Never give away the answer.';
const languageRule = (code) => {
  if (code === 'hi-IN') return HINDI_RULE;
  const l = LANGUAGES[code];
  return `The learner asked to talk in ${l.name}. Speak only in simple, friendly, polite ${l.name}, written in ${l.script} script (not Hindi, and not in Latin letters). Keep the task's key words in English letters, exactly as given in MUST INCLUDE. When the task is to talk about something, invite them to try it in English (${l.name} is fine too). Never give away the answer.`;
};

const SITUATIONS = {
  answered: "The learner just answered. React to what they said in their last line, not to earlier topics.",
  answered_task: 'The learner just answered a word task. The reaction is only a brief, neutral acknowledgement (like "Okay!" or "Got it."): don\'t say whether it was right, and nothing about earlier topics.',
  next_part: 'The learner just answered the first word question. The reaction is only a brief, neutral acknowledgement (like "Okay!"): don\'t say whether it was right. In ask, ask only the next question (TASK), nothing else.',
  moved_on: "The learner couldn't answer the last task, or asked to skip it. Be kind and reassuring; don't dwell on it.",
  switch_language: 'The learner just asked to talk in the language given under LANGUAGE. In the reaction, say yes warmly in that language, and tell them they can also use English whenever they like. Then in ask, ask the same task again, in that language.',
  meta: "Instead of answering, the learner said something to you about the conversation (their last line). In the reaction, respond to that line directly in a few words: if it corrects you, apologise simply and accept it; if it asks you something, answer it briefly. Then in ask, come back to the same task in fresh words (don't repeat your last line word for word).",
  probe: 'The learner just read a sentence from the screen (not their own words). The reaction is only a brief thanks, nothing about earlier topics. Ask them to try one more sentence, now on their screen. Do not say how well they read.',
  read_done: 'The learner just read a sentence aloud from the screen. Those were not their own words. The reaction is only a brief thanks, nothing about the sentence or earlier topics.',
  finish: 'The conversation is ending.',
};

// Sakhi stays warm about what was said, never about how well it was said: no corrections, no verdicts.
// Any sentence (in the reaction or the task line) that matches is dropped before Sakhi speaks. Apologies
// ("sorry, my mistake") are allowed: Sakhi needs them when the learner corrects her.
const CORRECTION = /\b(should (?:say|be)|correct(?:ly|ion)?|incorrect|(?:you made|you make|small|little|one|a few|some|no|any) mistakes?|(?:that(?:'s| is)|it(?:'s| is)|answer is|word is) (?:a bit |a little |slightly |not )?(?:wrong|right)|you(?:'re| are) (?:a bit |a little |slightly )?wrong|wrong (?:word|answer)|grammar|instead of|you meant|the right word|right answer|perfect(?:ly)?|exactly( right)?|spot on|well said|well done|did (?:very |really )?well|great (?:job|answer|reading)|good (?:job|answer|reading)|know (?:those|these|the|so many|a lot of|many) (?:english )?words|(?:so|very|really) well|excellent|nailed|clearly|fluen(?:t|cy)|good english|your english|pronunciation|accent)\b/i;
// The same in Hindi and Punjabi ("सही है", "बिल्कुल सही", "ਬਹੁਤ ਵਧੀਆ"…). Not "ग़लती": "sorry, my mistake" is an apology.
const CORRECTION_HI = /(ਬਹੁਤ ਵਧੀਆ|ਸਹੀ ਹੈ|ਬਿਲਕੁਲ ਸਹੀ|ਸ਼ਾਬਾਸ਼|ਗਲਤ ਹੈ|ਵਿਆਕਰਣ|ਉਚਾਰਣ|ਤੁਹਾਡੀ ਅੰਗਰੇਜ਼ੀ|सही है|सही था|सही जवाब|सही शब्द|बिल्कुल सही|एकदम सही|ग़लत है|गलत है|ग़लत जवाब|गलत जवाब|शाबाश|बहुत बढ़िया|बहुत अच्छा बोल|अच्छा जवाब|बढ़िया जवाब|उच्चारण|व्याकरण|आपकी अंग्रेज़ी|आपकी इंग्लिश)/;
const sentences = (t) => t.match(/[^.!?।]+[.!?।]*\s*/g) || [t];
export const stripVerdicts = (t) => sentences(t || '').filter((s) => !CORRECTION.test(s) && !CORRECTION_HI.test(s) && !/\bTASK\b/.test(s)).join('').trim();
const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const has = (text, needle) => text.toLowerCase().normalize('NFKC').includes(needle.toLowerCase().normalize('NFKC'));

// ---- names ------------------------------------------------------------------------
// The model sometimes addresses the learner by a name they never gave ("Thank you, Riya."). Sakhi may only
// use the name the learner told us; any other name used to address them is removed before she speaks.
const NOT_NAMES = new Set(('sakhi okay ok now so well yes no oh ah aha hmm great nice sure alright thanks please achha accha acha achcha '
  + 'wow hey hi hello namaste look listen then next first also and but right cool good lovely haha ji sorry arre chalo haan '
  + 'hindi english friend dear wonderful awesome amazing interesting true fine perfect indeed yeah yep anyway see tell try let '
  + 'oops wah waah shabash ooh today tomorrow yesterday sunday monday tuesday wednesday thursday friday saturday everyone there '
  + 'go come say read think imagine guess remember tea chai india delhi mumbai').split(/\s+/));
const isNameLike = (w, known) => {
  const lw = w.toLowerCase();
  if (known && known.toLowerCase().split(/\s+/).includes(lw)) return false;
  return !NOT_NAMES.has(lw) && !/(ly|ing)$/.test(lw);
};
const capFirst = (t) => t.replace(/^(\s*)(\p{Ll})/u, (_, sp, c) => sp + c.toUpperCase());

/** Remove names used to address the learner, unless it's the name they told us. */
export function stripInventedNames(text, knownName) {
  if (!text) return text;
  const N = '([A-Z][a-z]{1,15})(?:\\s+ji)?';
  return text
    // "Thank you Riya" / "Hi Riya" (no comma)
    .replace(new RegExp(`\\b([Tt]hanks|[Tt]hank you|[Hh]i|[Hh]ello|[Hh]ey|[Nn]amaste|[Bb]ye|[Ww]elcome|[Dd]ear) ${N}\\b`, 'g'), (m, lead, w) => (isNameLike(w, knownName) ? lead : m))
    // "…, Riya." / "…, Riya, …"
    .replace(new RegExp(`,\\s*${N}(?=\\s*([.!?,…]|$))`, 'g'), (m, w) => (isNameLike(w, knownName) ? '' : m))
    // "Riya, tell me…" at the start of a sentence
    .replace(new RegExp(`(^|[.!?।]\\s+)${N},\\s*`, 'g'), (m, before, w) => (isNameLike(w, knownName) ? before : m))
    .replace(/(^|[.!?।]\s+)(\p{Ll})/gu, (m, b, c) => b + c.toUpperCase())
    .replace(/\s+([.!?,])/g, '$1').replace(/,([.!?])/g, '$1').trim();
}

/** The line Sakhi says, with the name check applied (the name may have been learned while it was written). */
export function sayable(said, knownName) {
  const reaction = stripInventedNames(said.reaction, knownName);
  const ask = stripInventedNames(said.ask, knownName);
  return { text: [reaction, ask].filter(Boolean).join(' '), ask };
}

/** Does a proposed task line keep the task intact? → { ok, reason } */
export function checkAsk(ask, task, { language = null } = {}) {
  if (!ask || !ask.trim()) return { ok: false, reason: 'empty' };
  // Talking in another language: the line has to be in it (English task words inside are fine).
  if (LANGUAGES[language] && !LANGUAGES[language].re.test(ask)) return { ok: false, reason: `not in ${LANGUAGES[language].name}` };
  if (words(ask) > 70) return { ok: false, reason: 'too long' };
  const spec = task.tutor || {};
  for (const w of spec.mustNotSay || []) {
    if (has(ask, w)) return { ok: false, reason: `gives away "${w}"` };
  }
  for (const group of spec.mustInclude || []) {
    if (!group.some((w) => has(ask, w))) return { ok: false, reason: `missing "${group[0]}"` };
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
  return history.slice(-12).map((h) => (h.who === 'sakhi' ? `Sakhi: ${h.text}`
    : h.reading ? `Learner (reading a sentence from the screen, not their own words): ${h.text}` : `Learner: ${h.text}`)).join('\n') || '(nothing yet)';
}

function aboutText(profile = {}) {
  return [
    profile.name ? `- Name: ${profile.name}` : '- Name: not known. Do not use any name.',
    profile.facts?.length ? `- What they've told you (background; mention only when it fits naturally): ${profile.facts.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Write Sakhi's next line. → { reaction, ask, fallback?: reason }  (use sayable() to get the spoken text)
 * task: { brief | tutor.brief, tutor: { mustInclude, mustNotSay }, scripted, hindi?, reference?, followup?, summary? }
 */
export async function compose({ history, level, profile = {}, situation, note, task }, trace) {
  const spec = task.tutor || {};
  const quote = (w) => `"${w}"`;
  const user = [
    `LEARNER LEVEL: ${level} of 4 (1 = beginner, 4 = very fluent)`,
    `LANGUAGE: ${LANGUAGES[profile.language] ? languageRule(profile.language) : LANGUAGE_RULES[level] || LANGUAGE_RULES[2]}`,
    `ABOUT THE LEARNER:\n${aboutText(profile)}`,
    `CONVERSATION SO FAR:\n${historyText(history)}`,
    `WHAT JUST HAPPENED: ${note || SITUATIONS[situation] || SITUATIONS.answered}`,
    `TASK: ${task.brief || spec.brief}`,
    spec.mustInclude?.length ? `MUST INCLUDE (from each group, use at least one of these exact words, naturally): ${spec.mustInclude.map((g) => g.map(quote).join(' or ')).join('; ')}` : '',
    spec.mustNotSay?.length ? `MUST NOT SAY: ${spec.mustNotSay.map(quote).join(', ')}` : '',
    task.reference ? 'The sentence is on their screen. Do not say any part of it.' : '',
  ].filter(Boolean).join('\n');

  // One try, and if the line fails a check (a task word missing, the wrong language…), one more try that
  // says what was wrong. A slow reply is worse than a scripted one: each try gets 4 s, and there's no
  // second try if the first was slow.
  const attempt = async (extra) => {
    const meta = {};
    const messages = [{ role: 'system', content: TUTOR_SYSTEM }, { role: 'user', content: user + (extra ? `\n${extra}` : '') }];
    const reply = sarvam.chatJSON(messages, { model: config.sarvam.llmReplyModel, temperature: 0.7, maxTokens: 300, meta, purpose: 'tutor' });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('tutor took over 4 s')), 4000));
    const out = await trace.time('tutor', () => Promise.race([reply, timeout]),
      (r) => ({ model: meta.model, situation, task: task.id, ...(extra ? { retry: true } : {}), reaction: r?.reaction, ask: r?.ask, usage: meta.usage })).catch(() => null);
    // The closing summary has no reaction, and it is allowed to say how they did; every other line isn't.
    const reaction = task.summary ? '' : checkReaction(out?.reaction);
    // The summary may say how they did, but it ends the conversation: no questions.
    let proposed = task.summary ? sentences(out?.ask || '').filter((x) => !x.includes('?')).join('').trim() : stripVerdicts(out?.ask);
    // One question at a time: anything after the first question mark is dropped. A read-aloud line is an
    // instruction, so it has no question at all ("Are you ready?" would get an answer instead of the reading).
    if (task.reference && !task.summary) proposed = sentences(proposed).filter((x) => !x.includes('?')).join('').trim();
    else if (!task.summary && proposed.includes('?')) proposed = proposed.slice(0, proposed.indexOf('?') + 1);
    return { out, reaction, proposed, check: out ? checkAsk(proposed, task, { language: profile.language }) : { ok: false, reason: 'no reply from the model' } };
  };
  const t0 = performance.now();
  let r = await attempt();
  if (!r.check.ok && r.out && performance.now() - t0 < 2500) {
    trace.add('tutor-retry', { task: task.id, reason: r.check.reason });
    r = await attempt(`Your previous line was rejected (${r.check.reason}). Write it again and fix that.`);
  }
  const { reaction, proposed, check, out } = r;
  // Scripted fallback: in Hindi if the learner asked for Hindi (there are no scripted lines in other languages).
  const ask = check.ok ? proposed : (profile.language === 'hi-IN' && task.hindi) || task.scripted;
  if (!check.ok) trace.add('tutor-fallback', { task: task.id, reason: check.reason, using: 'scripted line' });
  return { reaction, ask, ...(check.ok ? {} : { fallback: out ? check.reason : 'no reply' }) };
}
