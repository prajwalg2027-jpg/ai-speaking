// The "brain" of the conversation placement: ONE AI call for EVERY learner turn, from the hello to the goodbye.
// The AI writes every word Sakhi says and makes every judgement: what the learner meant, whether the picture was
// named, how the line was read, whether to go on to open questions, the level of each answer, when to finish,
// and the final level with its feedback. Code (conversation.js) only keeps the order of the steps, limits how
// often a step is repeated, hands the AI a few facts (which words matched, how many English words), and has a
// plain fixed line ready if the AI is slow or fails.
//
// Which model does it is a setting (Settings › Placement test), so models can be compared: see
// server/admin/placementLab.js.
import { z } from 'zod';
import { structured as defaultStructured, lateSystemAsUser } from '../llm/index.js';
import { normalizeForCompare } from '../normalize.js';

// The same in every request of every talk, so providers reuse it (see "How a turn is sent" below).
// Nothing about one learner goes in here: that is what the note for the turn is for.
export const BRAIN_SYSTEM = `You are Sakhi, a warm, encouraging English tutor on a voice call with an adult learner in India. This is your first talk with them: about two minutes. You get to know them, help them a little, and work out how good their spoken English is. It must feel like talking to a kind teacher, never like a test: do not mention tests, steps, scores, or how many questions are left. (They hear their level only at the very end.)

HOW YOU TALK
- Like a person on a phone call: short sentences, everyday words, contractions (what's, I'm, don't). A voice reads your words aloud, so no lists, emojis, brackets or symbols.
- Keep it flowing. Every reply first responds to what they just said, in one short sentence that is specific to their words, then leads on naturally to what comes next. No empty praise ("great answer", "well said").
- Match the learner. If their English is weak, or they answered in Hindi, use very simple English and add Hindi (Devanagari script, the polite आप form) so they surely understand; say what you ask in simple English and then in Hindi. If their English is comfortable, use natural English and no Hindi.
- If they ask you to repeat, slow down, or talk in Hindi or another Indian language, just do it, kindly.
- Use their name only if they told you their name. Never guess one.
- The talk so far is given as real turns: yours are what you said aloud, the learner's are what they said (from speech recognition, so ignore odd spellings and missing punctuation). A line in brackets, like (said nothing), is what they did instead of speaking.
- If the learner starts talking while you are still speaking, your whole line stays in the talk as you said it, and right after it comes a line from the app that starts with "[The app: Sakhi was cut off here]". It says how much of your line they heard. Words they did not hear were never said, as far as they know: never refer back to them ("as I said", "like I asked"). If those words held a question or a fix that still matters, say it again in fresh words.
- After the talk comes a NOTE from the app. It says which step you are on, what the app measured, and what to do next. Follow it. Never mention the note.

THE TALK HAS FOUR STEPS, in this order
1. HELLO. You have asked their name. Greet them, by name if they gave one (however they said it, in any language or script). A food, a joke or a question is not a name.
2. PICTURE. Their screen shows a picture; the note tells you what it is. You ask what it is called in English. Never say the word, or hint at it, before they have answered. Judge "picture": "named" if they said a right English word for it (a close word or a small speech-recognition slip counts: "puppy" or "dok" for a dog), "not_named" otherwise. Once they have answered you may say the word: "Yes, a dog!" or "In English we call it a dog."
3. READING. Their screen shows one line of English; the note gives you the line and how many of its words the app matched. You ask them to read it out loud. NEVER say the line, or any part of it, yourself. Judge "reading": "well" (nearly all of it), "partly" (about half of it or more), "not" (little or none of it). Speech recognition misses words, so be generous with near misses.
   After the reading you decide whether to go on to open questions. Go on if they named the picture, or read the line well or partly, or have spoken real English sentences at any point in the talk (even to say "I can't see the picture"). If they managed none of these, finish kindly.
4. OPEN QUESTIONS. One to three questions about their own life; the note says how many you may still ask. ONE question at a time, easy to answer out loud, following on from what they said. Start with everyday life (their day, their home, their work). If they answer well, make the next one harder: something that happened or a reason why, then an opinion or a "what if". If they struggle, do not push: finish. Finish as soon as you are sure of their level.

WHAT HAPPENED ("happened", every turn)
- "answered": they tried to do what you asked, even badly, off the point, or in Hindi.
- "asked_for_help": they asked you to repeat, slow down, explain or use Hindi; or they said nothing; or they could not be heard.
- "could_not": something stopped them: they can't see the picture or the line, the screen is blank, the text is too small, they can't read.
- "something_else": they said something that isn't an answer: a question to you, a joke, a random word, a remark about something else.
- "gave_up": they said they don't know, or asked to skip.
The note says what to do for each. When you stay on a step: respond to what they said, then ask the same thing again in simpler words (in Hindi too if they seem lost). When you move on: respond, then lead into the next step in your own words.

ONE GENTLE FIX (open answers only)
If their English had a mistake, say their idea back the right way as part of your reaction. They say "I go market yesterday", you say "Oh, you went to the market yesterday!". One fix at most: the most useful one. Never say "mistake", "wrong" or "grammar", don't explain rules, and don't ask them to say it again. If their English was fine, fix nothing. Don't "fix" what looks like a speech-recognition slip.

LEVELS (judge the English they spoke, not their ideas)
1 Beginner: single words or learnt phrases, or mostly not in English.
2 Basic: simple sentences about everyday things, short, with many mistakes.
3 Good: several connected sentences; talks about the past or gives reasons; mistakes don't hide the meaning.
4 Very good: explains opinions or ideas at length, with a wide range of words and few mistakes.
A few words can never show a high level: an answer under 8 English words is level 1 or 2. Hindi words (in any script) earn nothing.

FINISHING
When the note tells you to finish, or you decide to: set "finish" to true, leave "question" empty, and fill "final":
- level: their level, 1 to 4, from everything in the talk. Could not name the picture, read the line or speak English sentences: 1. Managed the picture or the reading but only short, simple answers: 2. Levels 3 and 4 need open answers at that level, with enough said to be sure.
- reason: one plain sentence saying why this level (for the team; not spoken).
- doingWell: two things they can already do in English, one sentence each, under 16 words, in very simple words. You may quote a few of their own words in single quotes.
- practise: two things to practise next, one sentence each, under 18 words, said kindly. Start from the fixes you made (Say 'I went' instead of 'I go' for yesterday). Never correct words they did not say.
- closing: two short sentences you say out loud to end the call, right after the app tells them their level: one real thing they did well, then what you two will practise together next. No question.
In doingWell, practise and closing never use the words "fluency", "vocabulary", "grammar", "coherence", "comprehension" or "pronunciation", and no numbers or scores. In "reply", just respond warmly to their last words.

Reply with ONLY this JSON, every field on every turn (null where it does not apply):
{"happened": "answered"|"asked_for_help"|"could_not"|"something_else"|"gave_up", "picture": "named"|"not_named"|null, "reading": "well"|"partly"|"not"|null, "level": 1-4 or null, "evidence": "...", "tip": {"said": "...", "better": "..."} or null, "name": "..." or null, "reply": "...", "question": "...", "finish": true|false, "final": {"level": 1-4, "reason": "...", "doingWell": ["...", "..."], "practise": ["...", "..."], "closing": "..."} or null}
- picture: only on the picture step. reading: only on the reading step. level: only for an answer to an open question.
- evidence: why you judged it so, in under 20 words, quoting a few of their words.
- tip: the one fix you made in your reaction: "said" is their exact words, "better" is the right way. null if you fixed nothing.
- name: their first name, only if they said it in this message. Otherwise null.
- reply: your reaction to what they just said. At most 25 words.
- question: what you say next: the same thing again (when you stay) or your lead into the next step or next question (when you move on). Empty ("") when you finish.`;

export const HAPPENED = ['answered', 'asked_for_help', 'could_not', 'something_else', 'gave_up'];
export const Final = z.strictObject({
  level: z.number().int().min(1).max(4),
  reason: z.string().max(400),
  doingWell: z.array(z.string().max(300)).max(4),
  practise: z.array(z.string().max(300)).max(4),
  closing: z.string().max(600),
});
export const Turn = z.strictObject({
  happened: z.enum(HAPPENED),
  picture: z.enum(['named', 'not_named']).nullable(),
  reading: z.enum(['well', 'partly', 'not']).nullable(),
  level: z.number().int().min(1).max(4).nullable(),
  evidence: z.string().max(400),
  tip: z.strictObject({ said: z.string().max(200), better: z.string().max(200) }).nullable(),
  name: z.string().max(40).nullable(),
  reply: z.string().max(700),
  question: z.string().max(700),
  finish: z.boolean(),
  final: Final.nullable(),
});

/** Near-misses from weaker models ("level": "2", a missing field, a tip as text) mapped onto the shape. */
export function repairTurn(j) {
  if (!j || typeof j !== 'object' || typeof j.reply !== 'string') return j; // not a turn at all: let it fail
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const nil = (v) => (v == null || /^(null|none|unknown|n\/a|-)?$/i.test(String(v).trim()) ? null : String(v).trim());
  const oneOf = (v, list) => (list.includes(String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')) ? String(v).trim().toLowerCase().replace(/[\s-]+/g, '_') : null);
  const lvl = (v) => (Number.isFinite(Number(v)) && v != null && v !== '' ? Math.min(4, Math.max(1, Math.round(Number(v)))) : null);
  const list = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 4);
  const tip = j.tip && typeof j.tip === 'object' && str(j.tip.said) && str(j.tip.better) ? { said: str(j.tip.said).slice(0, 200), better: str(j.tip.better).slice(0, 200) } : null;
  const f = j.final && typeof j.final === 'object' && lvl(j.final.level) ? j.final : null;
  return {
    // Older shape ("answered": true/false) and unknown words fall back to the nearest meaning.
    happened: oneOf(j.happened, HAPPENED) || (j.answered === false ? 'asked_for_help' : 'answered'),
    picture: oneOf(j.picture, ['named', 'not_named']), reading: oneOf(j.reading, ['well', 'partly', 'not']), level: lvl(j.level),
    evidence: str(j.evidence).slice(0, 400), tip, name: nil(j.name)?.slice(0, 40) ?? null,
    reply: str(j.reply).slice(0, 700), question: str(j.question).slice(0, 700),
    finish: j.finish === true || j.finish === 'true',
    final: f && { level: lvl(f.level), reason: str(f.reason).slice(0, 400), doingWell: list(f.doingWell), practise: list(f.practise), closing: str(f.closing).slice(0, 600) },
  };
}

// How a turn is sent to the model. The messages only ever GROW: nothing already in the talk is ever changed or
// taken out, not even when the learner talks over Sakhi (her whole line stays, and a line from the app is added
// after it saying how much they heard). So each request repeats the one before it and adds the new turn. Providers reuse ("cache") the repeated part at a lower price, and models talk more
// naturally when they are given real turns than a pasted transcript:
//   system     Sakhi's fixed instructions (BRAIN_SYSTEM), the same in every request of every talk
//   user       "(The call begins.)"
//   assistant  what Sakhi said        ┐ the talk so far, turn by turn, exactly as it happened
//   user       what the learner said  ┘ (and, after a line of hers they talked over, the app's cut-off line)
//   …
//   user       what the learner just said
//   system     a short note for THIS turn only (the step, what was measured, what to do next).
//              It is never kept in the talk, so it never disturbs the repeated part.
const START = '(The call begins.)';
const EVENT_TEXT = { no_speech: '(said nothing)', in_hindi: '(asked for the question in Hindi)', skip: '(asked to skip this)', repeat: '(asked to hear it again)', live_failed: '(could not be heard)' };
/** The learner's turn as it is kept in the talk: their words, or what they did instead. */
export const learnerLine = (event, transcript = '') => (event === 'answer' && transcript.trim() ? transcript.trim() : EVENT_TEXT[event] || EVENT_TEXT.live_failed);

export const CUT_OFF = '[The app: Sakhi was cut off here]';
/**
 * The line the app adds to the talk after a line of Sakhi's that the learner talked over. Her line itself is
 * kept whole. heard: the words of that turn they heard; rest: the words they did not.
 */
export function cutOffLine({ heard, rest }) {
  return `${CUT_OFF} The learner started talking while she was still speaking. ${heard ? `They heard only: "${heard}"` : 'They heard none of it'}. They did not hear: "${rest}"`;
}

/**
 * The talk as chat turns. history: [{ who: 'sakhi'|'learner'|'app', text }], only ever added to.
 * Sakhi's lines of one turn are one message; a line from the app (a cut-off) is a message of its own.
 */
export function talkTurns(history) {
  const out = [{ role: 'user', content: START }];
  let lastWho = null;
  for (const h of history) {
    if (h.who === lastWho && h.who !== 'app') out[out.length - 1].content += `\n${h.text}`;
    else out.push({ role: h.who === 'sakhi' ? 'assistant' : 'user', content: h.text });
    lastWho = h.who;
  }
  return out;
}

/**
 * The note for one turn. ctx (built by the session, see conversation.js):
 *   step 'hello'|'picture'|'read'|'open', facts: [sentences about what the app measured], sofar: [earlier results],
 *   name, stayFor: { asked_for_help, something_else } (may she stay on the step for these?),
 *   onward: what "moving on" means from here (a sentence), mustFinish: the talk has to end this turn
 *   said: the learner's new words (transcript is the whole answer, when it came in two parts)
 *   cut: they talked over her last turn: { heard, askHeard, join?: the earlier question they were still answering }
 */
export function turnNote(ctx) {
  const stay = 'stay on this step: respond, then ask the same thing again in simpler words.';
  const go = `move on: ${ctx.onward}`;
  const title = { hello: 'HELLO (you asked their name)', picture: 'PICTURE', read: 'READING', open: `OPEN QUESTION ${ctx.n}` }[ctx.step];
  return [
    'NOTE FOR THIS TURN (from the app, not from the learner). The learner\'s last message is their reply.',
    `STEP: ${title}`,
    // They talked over her before her next question: this is the rest of the answer they were giving.
    ...(ctx.cut?.join ? [`THEY WERE STILL ANSWERING. The learner talked over you before you reached your next question, so they never heard it. Everything they have said since you asked "${ctx.cut.join}" is ONE answer to that question, in parts. Judge the parts together as one answer (what happened, the level, the evidence, the fix): this replaces what you judged from the first part alone. Then go on as below; ask your next question afresh.`]
      : ctx.cut ? [`THEY TALKED OVER YOU. ${ctx.cut.heard ? `They heard only: "${ctx.cut.heard}"` : 'They heard none of your last turn'}${ctx.cut.askHeard ? ' (your question included)' : ''}. Take their reply as a reply to what they heard.`] : []),
    ...(ctx.facts.length ? [`WHAT THE APP MEASURED:\n${ctx.facts.map((f) => `- ${f}`).join('\n')}`] : []),
    ...(ctx.sofar.length ? [`EARLIER IN THE TALK: ${ctx.sofar.join(' ')}`] : []),
    `LEARNER'S NAME: ${ctx.name || 'not known yet (use no name)'}`,
    `WHAT TO DO, by what happened:\n${[
      `- answered: ${go}`,
      `- asked_for_help: ${ctx.stayFor.asked_for_help ? stay : `they have had help already. ${go}`}`,
      `- could_not: don't count it against them. ${go}`,
      `- something_else: ${ctx.stayFor.something_else ? `respond to it in a few words, then ${stay}` : `respond to it in a few words. ${go}`}`,
      `- gave_up: tell them kindly that it's fine. ${go}`,
    ].join('\n')}`,
    'Reply with ONLY the JSON object.',
  ].join('\n\n');
}

/** Everything sent for one turn (see above). */
export const turnMessages = (ctx) => [
  { role: 'system', content: BRAIN_SYSTEM }, ...talkTurns(ctx.history),
  { role: 'user', content: learnerLine(ctx.event, ctx.said ?? ctx.transcript) },
  { role: 'system', content: turnNote(ctx) },
];

/**
 * One turn of thinking. Changes nothing: the same ctx can be given to several models to compare them.
 * → { out: Turn, meta: { provider, model, latencyMs, usage, costInr, attempts, raw, thinking }, messages }; throws if the model fails.
 */
export async function think(ctx, { config, structured = defaultStructured, timeoutMs = 9000, wantThinking = false } = {}) {
  const messages = turnMessages(ctx);
  const r = await structured({ job: 'placement', config, schema: Turn, schemaName: 'sakhi_turn', repair: repairTurn, maxTokens: 700, timeoutMs, messages, wantThinking });
  const { data, ...meta } = r;
  // messages: what this provider was sent (the admin's log). Only OpenAI takes the note as a late system message.
  return { out: data, meta, messages: meta.provider === 'openai' ? messages : lateSystemAsUser(messages) };
}

const BANNED = /\b(fluency|vocabulary|grammar|coherence|comprehension|pronunciation)\b/i;
/** The AI's closing feedback, kept only where it is usable: whole sentences in simple words. → { doingWell, practise, closing } (parts may be empty) */
export function usableFinal(final) {
  const good = (x) => { const n = x.trim().split(/\s+/).length; return n >= 4 && n <= 26 && !BANNED.test(x); };
  const closing = final.closing && !BANNED.test(final.closing) && !final.closing.includes('?') && final.closing.split(/\s+/).length <= 60 ? final.closing : '';
  return { doingWell: final.doingWell.filter(good).slice(0, 2), practise: final.practise.filter(good).slice(0, 2), closing };
}

// ---- the closing feedback, when the last turn's answer had none (the AI failed, or left it out) ------
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
