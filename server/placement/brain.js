// The "brain" of the conversation placement: ONE AI call per learner turn. It reads what the learner said and
// returns everything for that turn together: whether it was an answer, the level of the answer, one gentle fix,
// what Sakhi says back, and her next question. (The classic test splits this over three calls that never see each
// other's work.) A second job writes the closing feedback, once, at the end.
//
// Which model does each job is a setting (Settings › Placement test), so models can be compared: see
// server/admin/placementLab.js. The level itself is decided in code (level.js), from the levels given here.
import { z } from 'zod';
import { structured as defaultStructured } from '../llm/index.js';
import { normalizeForCompare } from '../normalize.js';

export const BRAIN_SYSTEM = `You are Sakhi, a warm, encouraging English tutor on a voice call with an adult learner in India. This is your first chat with them: about two minutes. They have just told you their name, named a picture and read a line aloud; now you ask one to three questions. You are getting to know them, helping them a little, and quietly working out how good their spoken English is. It must feel like talking to a kind teacher, never like a test: do not mention tests, levels, scores, or how many questions are left.

HOW YOU TALK
- Like a person on a phone call: short sentences, everyday words, contractions (what's, I'm, don't). A voice reads your words aloud, so no lists, emojis, brackets or symbols.
- Match the learner. If their English is weak, or they answered in Hindi, use very simple English and add Hindi (Devanagari script, the polite आप form) so they surely understand; say the question in simple English and then in Hindi. If their English is comfortable, use natural English and no Hindi.
- If they ask you to repeat, slow down, or talk in Hindi or another Indian language, just do it, kindly.
- Use their name only if they told you their name. Never guess one.

EVERY TURN, THREE THINGS
1. React like a person to what they actually said, in one short sentence. Be specific to their words. No empty praise ("great answer", "well said").
2. Help once, gently. If their English had a mistake, say their idea back the right way as part of your reaction. They say "I go market yesterday", you say "Oh, you went to the market yesterday!". One fix at most: the most useful one. Never say "mistake", "wrong" or "grammar", don't explain rules, and don't ask them to say it again. If their English was fine, fix nothing.
3. Ask the next question, when NEXT tells you to: ONE question, easy to answer out loud, that follows on from what they said or from their life. Pitch it at the level NEXT gives.

QUESTION LEVELS
1: a closed question, answered with a word or two: a choice ("Do you work or study?", "Do you like tea or coffee?") or a simple fact about them. Never open-ended. You may offer a start, like "I like...".
2: everyday life in simple sentences (their day, their home, their work).
3: needs a few connected sentences: something that happened, a plan, or a reason why.
4: an opinion or a "what if" that needs explaining, like weighing two sides.

THE LEVEL OF THEIR ANSWER (judge the English they spoke, not their ideas)
1 Beginner: single words or learnt phrases, or mostly not in English.
2 Basic: simple sentences about everyday things, short, with many mistakes.
3 Good: several connected sentences; talks about the past or gives reasons; mistakes don't hide the meaning.
4 Very good: explains opinions or ideas at length, with a wide range of words and few mistakes.
A few words can never show a high level: under 8 English words is level 1 or 2. Hindi words (in any script) earn nothing. The text comes from speech recognition: ignore odd spellings and missing punctuation, and don't "fix" what looks like a recognition slip.

Reply with ONLY this JSON:
{"answered": true|false, "level": 1-4 or null, "evidence": "...", "tip": {"said": "...", "better": "..."} or null, "name": "..." or null, "reply": "...", "question": "..."}
- answered: true if they tried to answer the current question, even badly, off the point, or in Hindi. false if they asked for help or another language, said they didn't understand or don't know, said nothing, or spoke to you about something else.
- level: the level of their answer (null when answered is false).
- evidence: why that level, in under 20 words, quoting a few of their words.
- tip: the one fix you made in your reaction: "said" is their exact words, "better" is the right way. null if you fixed nothing.
- name: their first name, only if they said it in this message. Otherwise null.
- reply: your reaction, with the gentle fix inside it. At most 25 words. When answered is false: your kind response to what happened.
- question: what NEXT asks for. Empty ("") when NEXT says to finish.`;

export const Turn = z.strictObject({
  answered: z.boolean(),
  level: z.number().int().min(1).max(4).nullable(),
  evidence: z.string().max(400),
  tip: z.strictObject({ said: z.string().max(200), better: z.string().max(200) }).nullable(),
  name: z.string().max(40).nullable(),
  reply: z.string().max(700),
  question: z.string().max(700),
});

/** Near-misses from weaker models ("level": "2", a missing field, a tip as text) mapped onto the shape. */
export function repairTurn(j) {
  if (!j || typeof j !== 'object' || typeof j.reply !== 'string' || !('answered' in j)) return j; // not a turn at all: let it fail
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const nil = (v) => (v == null || /^(null|none|unknown|n\/a|-)?$/i.test(String(v).trim()) ? null : String(v).trim());
  const level = Number(j.level);
  const tip = j.tip && typeof j.tip === 'object' && str(j.tip.said) && str(j.tip.better) ? { said: str(j.tip.said).slice(0, 200), better: str(j.tip.better).slice(0, 200) } : null;
  return {
    answered: j.answered === true || j.answered === 'true',
    level: Number.isFinite(level) && j.level != null && j.level !== '' ? Math.min(4, Math.max(1, Math.round(level))) : null,
    evidence: str(j.evidence).slice(0, 400), tip, name: nil(j.name)?.slice(0, 40) ?? null,
    reply: str(j.reply).slice(0, 700), question: str(j.question).slice(0, 700),
  };
}

const LEVEL_WORDS = { 1: 'a level 1 question', 2: 'a level 2 question', 3: 'a level 3 question', 4: 'a level 4 question' };
const stepWords = (step) => (step.done ? 'finish. Leave "question" empty: Sakhi closes the talk herself.' : `ask ${LEVEL_WORDS[step.target]}.`);

/**
 * The message for one turn. ctx (built by the session, see conversation.js):
 *   history [{who, text}], question { text, target }, event, transcript, measured { englishWords, wpm, longPauses },
 *   name, afterLevel { 1..4: step }, notAnswered: { help: true } | { step }
 */
export function turnMessage(ctx) {
  const said = {
    answer: `THE LEARNER JUST SAID: "${ctx.transcript}"`,
    no_speech: 'THE LEARNER SAID NOTHING (silence). They may not have understood. "answered" is false.',
    in_hindi: 'THE LEARNER TAPPED "IN HINDI": they want the question in Hindi. "answered" is false.',
    skip: 'THE LEARNER CHOSE TO SKIP THIS QUESTION. "answered" is false.',
  }[ctx.event];
  const m = ctx.measured;
  const next = [
    ...[1, 2, 3, 4].map((l) => `- If their answer is level ${l}: ${stepWords(ctx.afterLevel[l])}`),
    ctx.notAnswered.help
      ? '- If they did not answer: help them, then ask the CURRENT QUESTION again in simpler words (in Hindi too if they seem lost).'
      : `- If they did not answer: tell them kindly that it's fine, then ${stepWords(ctx.notAnswered.step)}`,
  ];
  return [
    `CONVERSATION SO FAR:\n${ctx.history.slice(-12).map((h) => `${h.who === 'sakhi' ? 'Sakhi' : 'Learner'}: ${h.text}`).join('\n') || '(nothing yet)'}`,
    `CURRENT QUESTION (level ${ctx.question.target}): "${ctx.question.text}"`,
    said,
    ctx.event === 'answer' && m ? `MEASURED FROM THEIR VOICE: ${m.englishWords} English words${m.wpm ? `, about ${Math.round(m.wpm)} words a minute` : ''}${m.longPauses ? `, ${m.longPauses} long pause${m.longPauses > 1 ? 's' : ''}` : ''}.` : '',
    `LEARNER'S NAME: ${ctx.name || 'not known (use no name)'}`,
    `NEXT:\n${next.join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * One turn of thinking. Changes nothing: the same ctx can be given to several models to compare them.
 * → { out: Turn, meta: { provider, model, latencyMs, usage, costInr, attempts } }; throws if the model fails.
 */
export async function think(ctx, { config, structured = defaultStructured, timeoutMs = 9000 } = {}) {
  const r = await structured({
    job: 'placement', config, schema: Turn, schemaName: 'sakhi_turn', repair: repairTurn, maxTokens: 500, timeoutMs,
    messages: [{ role: 'system', content: BRAIN_SYSTEM }, { role: 'user', content: turnMessage(ctx) }],
  });
  const { data, ...meta } = r;
  return { out: data, meta };
}

// ---- the closing feedback -------------------------------------------------------------------------
export const SUMMARY_SYSTEM = `You are Sakhi, a warm English tutor in India. Your first short talk with a learner has just ended. Write their feedback.
Use very simple English: short sentences and everyday words a beginner knows. Never use the words "fluency", "vocabulary", "grammar", "coherence", "comprehension" or "pronunciation". No numbers, levels or scores. Talk to them as "you". Base everything on what they actually said; never mention anything that went wrong in the call.
Reply with ONLY this JSON: {"doingWell": ["...", "..."], "practise": ["...", "..."], "closing": "..."}
- doingWell: two things they can already do in English, one sentence each, under 16 words. You may quote a few of their own words in single quotes.
- practise: two things to practise next, one sentence each, under 18 words, said kindly. Start from FIXES (things you already helped with in the talk), like: Say 'I went' instead of 'I go' for yesterday. If there are fewer than two fixes, add a next step that grows from their answers (using 'because' to give a reason, joining two ideas, telling a story about the past). Never correct words they did not say.
- closing: what you say out loud to end the call, right after they hear their level. Two short sentences: one real thing they did well, then what you two will practise together next.
Use single quotes inside the sentences, never double quotes.`;

export const Summary = z.strictObject({
  doingWell: z.array(z.string().max(300)).max(4),
  practise: z.array(z.string().max(300)).max(4),
  closing: z.string().max(600),
});
const repairSummary = (j) => (j && typeof j === 'object' ? {
  doingWell: (Array.isArray(j.doingWell) ? j.doingWell : []).filter((x) => typeof x === 'string').slice(0, 4),
  practise: (Array.isArray(j.practise) ? j.practise : []).filter((x) => typeof x === 'string').slice(0, 4),
  closing: typeof j.closing === 'string' ? j.closing.trim().slice(0, 600) : '',
} : j);

const BANNED = /\b(fluency|vocabulary|grammar|coherence|comprehension|pronunciation)\b/i;
const FALLBACK = {
  1: { doingWell: ['You tried to answer in English.', 'You know some English words.'], practise: ['Next, we will learn everyday words.', 'Next, we will make short sentences.'] },
  2: { doingWell: ['You can answer simple questions in English.', 'You know many everyday words.'], practise: ['Next, we will make full sentences.', 'Next, we will talk about yesterday and tomorrow.'] },
  3: { doingWell: ['You can talk about your life in English.', 'You can join your ideas together.'], practise: ['Next, we will give reasons with more detail.', 'Next, we will learn stronger words.'] },
  4: { doingWell: ['You explain your ideas in English with ease.', 'You use a wide range of words.'], practise: ['Next, we will practise harder topics.', 'Next, we will work on precise words.'] },
};

/** A fix is only kept if "said" really is in the learner's words (not something the model imagined). */
export function tipIsTheirs(tip, transcript) {
  if (!tip) return false;
  const said = normalizeForCompare(tip.said).join(' '), better = normalizeForCompare(tip.better).join(' ');
  return !!said && said !== better && ` ${normalizeForCompare(transcript).join(' ')} `.includes(` ${said} `);
}

/**
 * The closing feedback. answers: [{ transcript, level, evidence, tip }] (answered ones), level: the result.
 * → { doingWell: [2], practise: [2], closing, meta? }; never throws (plain lines for the level if the model fails).
 */
/** Plain feedback for a level, without the AI. known: things the picture and the reading showed. */
export function plainSummary({ answers, level, known = [] }) {
  const fb = FALLBACK[level] || FALLBACK[2];
  const fromTips = answers.filter((a) => a.tip).map((a) => `Say '${a.tip.better}' instead of '${a.tip.said}'.`);
  const doingWell = [...known, ...fb.doingWell].slice(0, 2), practise = [...fromTips, ...fb.practise].slice(0, 2);
  return { doingWell, practise, closing: `${doingWell[0]} ${practise[0]}` };
}

export async function summarize({ answers, level, known = [] }, { config, structured = defaultStructured, timeoutMs = 9000 } = {}) {
  const fixes = answers.filter((a) => a.tip).map((a) => `- they said '${a.tip.said}'; better: '${a.tip.better}'`);
  const user = [
    `WHAT THEY SAID:\n${answers.map((a) => `- ${a.transcript}`).join('\n') || '(almost nothing)'}`,
    known.length ? `ALSO, EARLIER IN THE TALK: ${known.join(' ')}` : '',
    `FIXES:\n${fixes.join('\n') || '(none)'}`,
    `HOW STRONG THEIR ENGLISH IS: ${{ 1: 'a beginner', 2: 'basic', 3: 'good', 4: 'very good' }[level]} (don't say this; it sets how simple your words must be).`,
  ].filter(Boolean).join('\n\n');
  const plain = plainSummary({ answers, level, known });
  try {
    const { data, ...meta } = await structured({
      job: 'placementSummary', config, schema: Summary, schemaName: 'sakhi_summary', repair: repairSummary, maxTokens: 500, timeoutMs,
      messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: user }],
    });
    const good = (x) => { const n = x.trim().split(/\s+/).length; return n >= 4 && n <= 26 && !BANNED.test(x); };
    const doingWell = data.doingWell.filter(good).slice(0, 2), practise = data.practise.filter(good).slice(0, 2);
    const closing = data.closing && !BANNED.test(data.closing) && !data.closing.includes('?') && data.closing.split(/\s+/).length <= 60 ? data.closing : '';
    if (!doingWell.length || !practise.length) return { ...plain, closing: closing || plain.closing, meta, fallback: 'no usable sentences' };
    return { doingWell, practise, closing: closing || `${doingWell[0]} ${practise[0]}`, meta };
  } catch (e) {
    return { ...plain, fallback: e.message };
  }
}
