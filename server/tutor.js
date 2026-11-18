// The tutor: writes what Sakhi says between tasks, so the placement feels like a conversation.
//
// The assessment tasks stay fixed (what's measured, the words, the difficulty). Sarvam-105B (the
// conversations variant) only writes the wrapper: a reaction to what the learner just said, a bridge, and the
// task in natural words. Every line is checked before Sakhi says it; if a check fails, the scripted line is used.
import * as sarvam from './sarvam.js';
import { config } from './config.js';
import { normalizeForCompare } from './normalize.js';
import { LANGUAGES } from '../shared/languages.js';
import { EXPLAIN_SYSTEM, SKILL_WORDS } from './prompts.js';

export const TUTOR_SYSTEM = `You are Sakhi, a warm and encouraging English tutor in a voice app for learners in India. You are having a friendly spoken conversation. Inside it you are quietly checking the learner's English level, but you never mention tests, levels, scores, questions or how many are left.

Write what Sakhi says next as JSON: {"reaction": "...", "ask": "..."}
- reaction: one short, simple sentence (at most 12 words) responding to the learner's LAST line, the way a friend would on a phone call: pick up one concrete thing from their last line, in your own fresh words (vary how you start; not always "… sounds fun"). Don't bring back things from earlier in the conversation. Don't comment on whether their answer fit the question, on changes of topic, or on how they said it: no corrections and no verdicts ("nice one", "perfect", "correct", "exactly", "well said", "good grammar", "your English is"). No empty fillers ("I hear you", "That's interesting", "I see what you mean"). Never ask a question here. Use "" when there is nothing to react to.
- ask: what Sakhi says next, ending with what the TASK below asks for (never say the word "task"). Usually just the question itself: one short, simple sentence (at most 15 words), easy to answer out loud. Ask exactly one thing: no second question, no "or" choices ("…, or do you…?"), no "and also". Don't repeat what they said back to them, don't teach, explain or introduce words.
Names: use the learner's name only if it is given under ABOUT THE LEARNER, and only now and then. If no name is given there, don't use any name, and never guess or invent one. Names in a sentence they read from the screen are not their name.
Speak like a person talking, not writing: short sentences, contractions (what's, I'm, don't), everyday words, and each sentence must follow on from the one before. No lists, no emojis, no markdown, nothing hard to say out loud.
Follow LANGUAGE exactly. Never say anything on the MUST NOT SAY list, and never give away the answer to the task.`;

const LANGUAGE_RULES = {
  1: 'The learner is a beginner. Use very simple, short English with common words. Then add ONE short sentence in Hindi (Devanagari script) that restates the task simply, in the polite आप form (बताइए, पढ़िए, कीजिए; never बताओ). The Hindi must not give away the answer either. Keep the key task words in English.',
  2: 'The learner knows some English. Use simple, clear English. You may add a Hindi word or two only if the learner used Hindi.',
  3: 'The learner speaks English comfortably. Use natural, friendly English. No Hindi.',
  4: 'The learner is very fluent. Use natural, rich English; you can be a little playful. No Hindi.',
};
// The learner asked to talk in another language: this replaces the level rule for the rest of the conversation.
const HINDI_RULE = 'The learner asked to talk in Hindi. Speak in simple, friendly Hindi (Devanagari script, the polite आप form: बताइए, पढ़िए, कीजिए; never बताओ). Keep the task\'s key words in English, exactly as given. When the task is to talk about something, invite them to try it in English (Hindi is fine too). Never give away the answer.';
// The conversation starts in Hindi and moves to English as the learner answers in English (session.js: support).
const HINDI_LEAD_RULE = 'Speak in simple, friendly Hindi (Devanagari script, the polite आप form: बताइए, पढ़िए, कीजिए; never बताओ), so the learner surely understands. Keep the task\'s key words in English, exactly as given. When the task is to talk about something, ask them to answer in English (a few words is fine). Never give away the answer.';
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
const CORRECTION = /\b(should (?:say|be)|correct(?:ly|ion)?|incorrect|(?:you made|you make|small|little|one|a few|some|no|any) mistakes?|(?:that(?:'s| is)|it(?:'s| is)|answer is|word is) (?:a bit |a little |slightly |not )?(?:wrong|right)|you(?:'re| are) (?:a bit |a little |slightly )?wrong|wrong (?:word|answer)|grammar|instead of|you meant|the right word|right answer|perfect(?:ly)?|exactly( right)?|spot on|well said|well done|did (?:very |really )?well|great (?:job|answer|reading)|good (?:job|answer|reading)|know (?:those|these|the|so many|a lot of|many) (?:english )?words|(?:so|very|really) well|excellent|nailed|clearly|fluen(?:t|cy)|good english|your english|pronunciation|accent|you used|(?:nice|good|great) use of|(?:nice|good|great) one|you got it|that's it|that's right|bingo)\b/i;
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
  + 'go come say read think imagine guess remember tea chai india delhi mumbai '
  + 'beginner basic level').split(/\s+/)); // level names: "…level 2 of 4, Basic." is not a name
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
  const reaction = fixContractions(stripInventedNames(said.reaction, knownName));
  const ask = fixContractions(stripInventedNames(said.ask, knownName));
  return { text: [reaction, ask].filter(Boolean).join(' '), ask };
}

/** The model sometimes drops the apostrophe in JSON ("what s the difference", "I m"): put it back. */
export function fixContractions(t) {
  if (!t) return t;
  return t
    .replace(/\b(what|that|it|there|here|let|he|she|who|where|how|everyone|today)\s+s\b/gi, "$1's")
    .replace(/\b(don|doesn|didn|can|won|isn|aren|wasn|weren|haven|hasn|couldn|wouldn|shouldn)\s+t\b/gi, "$1't")
    .replace(/\bI\s+m\b/g, "I'm").replace(/\b(you|we|they)\s+re\b/gi, "$1're")
    .replace(/\b(I|you|we|they)\s+(ll|ve|d)\b/g, "$1'$2")
    .replace(/\btell me s\b/gi, "tell me what's");
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
  if (task.reference || task.secret) {
    // Read-aloud: Sakhi must not say the sentence; listening: her lead-in must not give away the sentences or
    // the question (no run of 4 of their words).
    const ref = normalizeForCompare(task.reference || task.secret), said = ` ${normalizeForCompare(ask).join(' ')} `;
    for (let i = 0; i + 4 <= ref.length; i++) if (said.includes(` ${ref.slice(i, i + 4).join(' ')} `)) return { ok: false, reason: 'reads the sentence out' };
  }
  if (task.followup && !ask.includes('?')) return { ok: false, reason: 'follow-up is not a question' };
  if (task.summary?.levelName && !has(ask, task.summary.levelName)) return { ok: false, reason: 'summary lacks the level name' };
  return { ok: true };
}

const READ_WORDS = /\bread(?:ing)?\b|पढ़|ਪੜ੍ਹ|পড়|વાંચ|वाच|படி|చదువ|ಓದ|വായി|ପଢ/i;
/**
 * One question at a time: the first question stays, any later question is dropped; sentences that aren't
 * questions stay ("What food do you like? Start with 'I like'."). In a read-aloud line, a question that isn't
 * about reading ("Are you ready?") is dropped too: it would get an answer instead of the reading.
 */
export function oneQuestion(text, task = {}) {
  let asked = false, askedLatin = false;
  return sentences(text || '').filter((x) => {
    if (!x.includes('?')) return true;
    // The same question again in Hindi, after the English one (the mixed stage): not a second question.
    if (asked && askedLatin && /[\u0900-\u097F]/.test(x)) { askedLatin = false; return true; }
    if (task.kind === 'listen') return false; // the lead-in only says "listen": the question comes after the sentences
    if (task.reference && !READ_WORDS.test(x)) return false;
    if (asked) return false;
    asked = true; askedLatin = !/[\u0900-\u097F]/.test(x);
    return true;
  }).join('').trim();
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

function aboutText(profile = {}, { facts = false } = {}) {
  return [
    profile.name ? `- Name: ${profile.name}` : '- Name: not known. Do not use any name.',
    // Earlier facts only help a question about their life; elsewhere the model drags them back in oddly.
    facts && profile.facts?.length ? `- What they've told you before (don't repeat these back; you may build the question on one): ${profile.facts.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * The result in simple words, from the learner's own answers. → { doingWell: [2], practise: [2] }
 * Falls back to lines built from their strongest and weakest skills.
 */
export async function explainResult({ answers, dims, level }, trace) {
  const meta = {};
  // Tips come from what they said in their own words: not word-game answers, listening answers or reading.
  const said = answers.filter((a) => !a.skipped && a.transcript && a.kind === 'open').map((a) => `- ${a.transcript}`).join('\n');
  const ranked = Object.entries(dims || {}).sort((a, b) => b[1] - a[1]).map(([k]) => SKILL_WORDS[k]);
  const user = `Their level: ${level} of 4.\nStrongest to weakest: ${ranked.join('; ')}.\nWhat they said in their own words:\n${said || '(only short answers)'}`;
  const call = sarvam.chatJSON([{ role: 'system', content: EXPLAIN_SYSTEM }, { role: 'user', content: user }], { model: config.sarvam.llmReplyModel, temperature: 0.4, maxTokens: 300, meta, purpose: 'tutor' });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('took over 5 s')), 5000));
  const r = await trace.time('explain', () => Promise.race([call, timeout]), (x) => ({ model: meta.model, ...x })).catch(() => null);
  // Keep sentences that are whole (4+ words, balanced brackets), in simple words, and that only quote words the
  // learner really said (a tip that "corrects" something they never said is dropped).
  const theirs = normalizeForCompare(answers.map((a) => a.transcript || '').join(' ')).join(' ');
  const quotesTheirs = (x) => [...x.matchAll(/'([^']{2,60})'/g)].every(([, q], i, all) => {
    // In "say 'better' (not 'theirs')", the quote after "not" must be theirs; other quotes may be the better way.
    const before = x.slice(0, x.indexOf(`'${q}'`)).toLowerCase();
    return !/\bnot\s*$|\(not\s*$/.test(before) || theirs.includes(normalizeForCompare(q).join(' '));
  });
  const good = (x) => typeof x === 'string' && x.split(/\s+/).length >= 4 && x.split(/\s+/).length <= 24 && !BANNED_WORDS.test(x)
    && (x.match(/\(/g) || []).length === (x.match(/\)/g) || []).length && quotesTheirs(x);
  const keep = (list) => (Array.isArray(list) ? list.filter(good).slice(0, 2) : []);
  const doingWell = keep(r?.doingWell), practise = keep(r?.practise);
  if (doingWell.length && practise.length) return { doingWell, practise };
  if (r) trace.add('explain-fallback', { reason: 'no usable sentences (jargon, too long, broken, or quoting words they never said)' });
  return {
    doingWell: ranked.slice(0, 2).map((w) => `You are good at ${w}.`),
    practise: ranked.slice(-2).reverse().map((w) => `Next, we will practise ${w}.`),
  };
}
const BANNED_WORDS = /\b(fluency|vocabulary|grammar|coherence|comprehension|pronunciation)\b/i;

/**
 * Write Sakhi's next line. → { reaction, ask, fallback?: reason }  (use sayable() to get the spoken text)
 * task: { brief | tutor.brief, tutor: { mustInclude, mustNotSay }, scripted, hindi?, reference?, followup?, summary? }
 */
/** How Sakhi talks: in the language they asked for, else by how far into English the conversation has moved. */
function ruleFor(profile, level, task = {}) {
  // The closing summary is always simple English (the result card shows the Hindi line).
  if (task.summary && !LANGUAGES[profile.language]) return LANGUAGE_RULES[Math.min(2, level)];
  if (LANGUAGES[profile.language]) return languageRule(profile.language);
  if (profile.support === 'hi') return HINDI_LEAD_RULE;
  if (profile.support === 'mix') return 'The learner is just starting to speak English. Write the reaction in simple, short English. Write "ask" as the question in very simple English, then the same question again in simple Hindi (Devanagari script, the polite आप form), so they surely understand. Keep the key task words in English. Never give away the answer.';
  return LANGUAGE_RULES[level] || LANGUAGE_RULES[2];
}
const talksIn = (profile) => profile.language || (profile.support === 'hi' ? 'hi-IN' : null);

// Word puzzles, pictures, listening and reading are asked in their reviewed words: the model's rewrites of them
// were garbled too often ("tell me s the difference between but, however and simple"). The model only writes the
// reaction before them. Open questions about the learner's life are still the model's own.
const NEUTRAL = { en: ['Okay.', 'Alright.', 'Thank you.', 'Got it.'], hi: ['ठीक है।', 'अच्छा।', 'धन्यवाद।'] };
const ackFor = (profile) => { const l = NEUTRAL[talksIn(profile) === 'hi-IN' ? 'hi' : 'en']; return l[Math.floor(Math.random() * l.length)]; };
/** The exact words for a fixed task in the language Sakhi is using, or null when the model has to write it. */
export function fixedAsk(task, profile = {}) {
  if (task.followup || task.summary || !task.scripted) return null;
  const lang = talksIn(profile);
  if (lang && lang !== 'hi-IN') return null; // no reviewed lines in other languages
  if (task.kind === 'listen') return lang === 'hi-IN' ? (task.leadHindi || task.scripted) : profile.support === 'mix' && task.leadHindi ? `${task.scripted} ${task.leadHindi}` : task.scripted;
  if (lang === 'hi-IN') return task.hindi || task.scripted;
  // The first question's English version opens with a greeting: asked again, it's just the question.
  const en = task.id === 'q1_intro' ? task.simple || task.scripted : task.scripted;
  return profile.support === 'mix' && task.hindi ? `${en} ${task.hindi}` : en;
}
// After a word task or a reading, the reaction is only an acknowledgement: no need to ask the model for it.
const ACK_ONLY = new Set(['answered_task', 'next_part', 'read_done', 'probe']);

export async function compose({ history, level, profile = {}, situation, note, task }, trace) {
  const fixed = fixedAsk(task, profile);
  if (fixed && ACK_ONLY.has(situation) && !note) {
    trace.add('tutor', { situation, task: task.id, reaction: '(acknowledgement)', ask: '(reviewed question)' });
    return { reaction: ackFor(profile), ask: fixed };
  }
  const spec = task.tutor || {};
  const quote = (w) => `"${w}"`;
  const user = [
    `LEARNER LEVEL: ${level} of 4 (1 = beginner, 4 = very fluent)`,
    `LANGUAGE: ${ruleFor(profile, level, task)}`,
    `ABOUT THE LEARNER:\n${aboutText(profile, { facts: !fixed && task.kind === 'open' })}`,
    `CONVERSATION SO FAR:\n${historyText(history)}`,
    `WHAT JUST HAPPENED: ${note || SITUATIONS[situation] || SITUATIONS.answered}`,
    fixed ? `NEXT: right after your reaction, Sakhi says exactly this (you don't write it): "${fixed}"\nWrite only the reaction, and set "ask" to "". The reaction must lead naturally into that line and must not ask anything.`
      : `TASK: ${task.brief || spec.brief}`,
    !fixed && spec.mustInclude?.length ? `MUST INCLUDE (from each group, use at least one of these exact words, naturally): ${spec.mustInclude.map((g) => g.map(quote).join(' or ')).join('; ')}` : '',
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
    let reaction = task.summary ? '' : checkReaction(out?.reaction);
    // The reaction mustn't give the answer away either (it comes right before the question).
    if (reaction && (spec.mustNotSay || []).some((w) => has(reaction, w))) { trace.add('tutor-reaction-dropped', { why: 'gave away the answer' }); reaction = ''; }
    if (fixed) return { out, reaction, proposed: fixed, check: { ok: true } };
    // The summary may say how they did, but it ends the conversation: no questions.
    // The summary has no separate reaction: anything the model put there is part of it.
    let proposed = task.summary ? sentences([out?.reaction, out?.ask].filter(Boolean).join(' ')).filter((x) => !x.includes('?') && (profile.language || !/[\u0900-\u097F]/.test(x))).join('').trim() : stripVerdicts(out?.ask);
    if (!task.summary) proposed = oneQuestion(proposed, task);
    let check = out ? checkAsk(proposed, task, { language: talksIn(profile) }) : { ok: false, reason: 'no reply from the model' };
    // Between Hindi and English: simple English, then the same in Hindi, so the learner still follows.
    if (check.ok && profile.support === 'mix' && !profile.language && !task.summary && !/[\u0900-\u097F]/.test(proposed)) check = { ok: false, reason: 'no Hindi sentence after the English' };
    // The Hindi half must be this question, not an earlier line copied from the conversation.
    if (check.ok && !task.summary) {
      const hindi = sentences(proposed).filter((x) => /[\u0900-\u097F]/.test(x)).map((x) => x.trim()).filter((x) => x.length > 12);
      if (hindi.some((x) => history.some((h) => h.who === 'sakhi' && h.text.includes(x)))) check = { ok: false, reason: 'the Hindi repeats an earlier question instead of this one' };
    }
    return { out, reaction, proposed, check };
  };
  const t0 = performance.now();
  let r = await attempt();
  if (!r.check.ok && r.out && performance.now() - t0 < 2500) {
    trace.add('tutor-retry', { task: task.id, reason: r.check.reason });
    r = await attempt(`Your previous line was rejected (${r.check.reason}). Write it again and fix that.`);
  }
  const { reaction, proposed, check, out } = r;
  // Scripted fallback: in Hindi if the learner asked for Hindi (there are no scripted lines in other languages).
  const ask = check.ok ? proposed : (talksIn(profile) === 'hi-IN' && task.hindi) || (profile.support === 'mix' && task.hindi ? `${task.scripted} ${task.hindi}` : task.scripted);
  if (!check.ok) trace.add('tutor-fallback', { task: task.id, reason: check.reason, using: 'scripted line' });
  return { reaction, ask, ...(check.ok ? {} : { fallback: out ? check.reason : 'no reply' }) };
}
