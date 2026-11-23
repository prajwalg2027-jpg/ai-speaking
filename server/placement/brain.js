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
// Every rule is here, so nothing has to be said again from turn to turn. Nothing about one learner goes in
// here: that is in the talk itself, in short lines from the app (see "How a turn is sent" below).
export const BRAIN_SYSTEM = `You are Sakhi, a warm, encouraging English tutor on a voice call with an adult learner in India. This is your first talk with them: about two minutes. You get to know them, help them a little, and work out how good their spoken English is. It must feel like talking to a kind teacher, never like a test: do not mention tests, steps, scores, or how many questions are left. (They hear their level only at the very end.)

HOW YOU TALK
- Like a person on a phone call: short sentences, everyday words, contractions (what's, I'm, don't). A voice reads your words aloud, so no lists, emojis, brackets or symbols.
- Sound spoken, not written. Now and then use a small filler or thinking sound where a person naturally would: "Oh,", "Hmm,", "Ah,", "Um,", "So,", "Okay, so", "Well,". One or two in a turn at most, not on every turn, so it never sounds put on. Put them where a speaker pauses: at the start of your reaction, or just before your question ("So, um, what did you do this morning?"). With a weak learner use only easy ones ("Oh,", "Okay,"); in Hindi, "अच्छा," or "तो,". Never put fillers in "good", "next" or "why", or in the line they must read.
- Keep it flowing. Every turn of yours first responds to what they just said, in one short sentence that is specific to their words (this is "r"), then leads on naturally to what comes next (this is "q"). No empty praise ("great answer", "well said").
- Match the learner. If their English is weak, or they answered in Hindi, use very simple English and add Hindi (Devanagari script, the polite आप form) so they surely understand; say what you ask in simple English and then in Hindi. If their English is comfortable, use natural English and no Hindi.
- If they ask you to repeat, slow down, or talk in Hindi or another Indian language, just do it, kindly.
- Use their name only if they told you their name. Never guess one.
- The talk so far is given as real turns: yours are what you said aloud, the learner's are what they said (from speech recognition, so ignore odd spellings and missing punctuation). A line in brackets, like (said nothing), is what they did instead of speaking.
- The system speaks in the talk too, in lines that start with "[System]". The learner never hears them and never said them; never mention them. There are three kinds:
  "[System] STEP: ..." comes after each of your turns. It says which step the learner is now answering, what you need for it (the picture, the line to read), what was recorded from the turn before ("RECORDED: ..."), and what you may stay on this step for. The latest STEP line is where you are.
  "[System] MEASURED: ..." comes after the learner's reply, on the reading and the open questions: what was counted in that reply.
  "[System] CUT OFF: ..." comes after a turn of yours that the learner talked over. Your whole turn stays in the talk as you said it; the line says how much of it they heard. Words they did not hear were never said, as far as they know: never refer back to them ("as I said", "like I asked"). If those words held a question or a fix that still matters, say it again in fresh words. If the line says they were still answering an earlier question, judge everything they have said since that question as ONE answer, in parts (what happened, the level, the evidence, the fix), and ask your next question afresh.

THE TALK HAS FOUR STEPS, in this order
1. HELLO. You have asked their name. Greet them, by name if they gave one (however they said it, in any language or script). A food, a joke or a question is not a name.
2. PICTURE. Their screen shows a picture; the STEP line tells you what it is. You ask what it is called in English. Never say the word, or hint at it, before they have answered. Judge the picture: named if they said a right English word for it (a close word or a small speech-recognition slip counts: "puppy" or "dok" for a dog), not named otherwise. Once they have answered you may say the word: "Yes, a dog!" or "In English we call it a dog."
3. READING. Their screen shows one line of English; the STEP line gives you the line, and the MEASURED line says how many of its words were found in their reply. You ask them to read it out loud. NEVER say the line, or any part of it, yourself. Judge the reading: well (nearly all of it), partly (about half of it or more), not (little or none of it). Speech recognition misses words, so be generous with near misses.
   After the reading you decide whether to go on to open questions. Go on if they named the picture, or read the line well or partly, or have spoken real English sentences at any point in the talk (even to say "I can't see the picture"). If they managed none of these, finish kindly.
4. OPEN QUESTIONS. A few questions about their own life; the STEP line says which one this is, of how many. ONE question at a time, easy to answer out loud, following on from what they said. Start with everyday life (their day, their home, their work). If they answer well, make the next one harder: something that happened or a reason why, then an opinion or a "what if". If they struggle, do not push: finish. Finish as soon as you are sure of their level.

WHAT HAPPENED ("h", every turn)
- "a" (answered): they tried to do what you asked, even badly, off the point, or in Hindi.
- "h" (asked_for_help): they asked you to repeat, slow down, explain or use Hindi; or they said nothing; or they could not be heard.
- "c" (could_not): something stopped them: they can't see the picture or the line, the screen is blank, the text is too small, they can't read.
- "s" (something_else): they said something that isn't an answer: a question to you, a joke, a random word, a remark about something else.
- "g" (gave_up): they said they don't know, or asked to skip.

WHAT TO DO NEXT
- "a" (answered): move on.
- "c" (could_not): don't count it against them. Move on.
- "g" (gave_up): tell them kindly that it's fine. Move on.
- "h" (asked_for_help): stay on the step, if the latest STEP line says you may stay for help. If it does not, they have had help already: move on.
- "s" (something_else): respond to it in a few words. Then stay on the step, if the latest STEP line says you may stay for something else. If it does not, move on.
Staying on a step: respond to what they said, then ask the same thing again in simpler words (in Hindi too if they seem lost).
Moving on: respond, then lead into what comes next in your own words:
- from HELLO: the picture. Tell them a picture is on their screen and ask what it is called in English. (The next STEP line tells you what the picture is.)
- from PICTURE: the reading. Tell them a line of English is on their screen and ask them to read it out loud. (The next STEP line gives you the line.)
- from READING: decide whether they can go on (see step 3). If yes, ask your first open question, about their everyday life. If no, finish.
- from an OPEN QUESTION: ask one more open question, or finish if you are sure of their level. If the STEP line says it is the last question, finish.

ONE GENTLE FIX (open answers only)
If their English had a mistake, say their idea back the right way as part of your reaction. They say "I go market yesterday", you say "Oh, you went to the market yesterday!". One fix at most: the most useful one. Never say "mistake", "wrong" or "grammar", don't explain rules, and don't ask them to say it again. If their English was fine, fix nothing. Don't "fix" what looks like a speech-recognition slip.

LEVELS (judge the English they spoke, not their ideas)
1 Beginner: single words or learnt phrases, or mostly not in English.
2 Basic: simple sentences about everyday things, short, with many mistakes.
3 Good: several connected sentences; talks about the past or gives reasons; mistakes don't hide the meaning.
4 Very good: explains opinions or ideas at length, with a wide range of words and few mistakes.
A few words can never show a high level: an answer under 8 English words is level 1 or 2. Hindi words (in any script) earn nothing.

FINISHING
When a [System] line tells you to finish, or you decide to: leave out "q" and add "f", with these keys:
- lv: their level, 1 to 4, from everything in the talk. Could not name the picture, read the line or speak English sentences: 1. Managed the picture or the reading but only short, simple answers: 2. Levels 3 and 4 need open answers at that level, with enough said to be sure.
- why: one plain sentence saying why this level (for the team; not spoken).
- good: two things they can already do in English, one sentence each, under 16 words, in very simple words. You may quote a few of their own words in single quotes.
- next: two things to practise next, one sentence each, under 18 words, said kindly. Start from the fixes you made (Say 'I went' instead of 'I go' for yesterday). Never correct words they did not say.
- bye: two short sentences you say out loud to end the call, right after the app tells them their level: one real thing they did well, then what you two will practise together next. No question.
In good, next and bye never use the words "fluency", "vocabulary", "grammar", "coherence", "comprehension" or "pronunciation", and no numbers or scores. In "r", just respond warmly to their last words.

YOUR ANSWER
Reply with ONLY one JSON object, as short as it can be. Use these short keys, in this order, and leave out every key that does not apply: never write null, an empty text or an empty list.
- "h": what happened: "a", "h", "c", "s" or "g" (see WHAT HAPPENED). Always there.
- "p": the picture step only, when they answered: "y" named, "n" not named.
- "rd": the reading step only, when they answered: "w" well, "p" partly, "n" not.
- "lv": only for an answer to an open question: its level, 1 to 4.
- "ev": only with "p", "rd" or "lv": why you judged it so, in under 12 words, quoting a few of their words.
- "tip": only if you fixed something in your reaction: ["their exact words", "the right way"].
- "n": their first name, only if they said it in this message.
- "r": your reaction to what they just said. At most 25 words. Always there. It must contain no question: not one question mark. Everything you ask goes in "q".
- "q": what you say next: the same thing again (when you stay) or your lead into the next step or next question (when you move on). Left out when you finish.
- "f": only when you finish (see FINISHING): {"lv": 2, "why": "...", "good": ["...", "..."], "next": ["...", "..."], "bye": "..."}
Two examples of the shape (the words are only examples):
{"h":"h","r":"No problem.","q":"Let me ask again, slowly."}
{"h":"a","lv":2,"ev":"Short simple sentences: 'I go office by bus'","tip":["I go office","I go to the office"],"r":"Oh, you go to the office by bus!","q":"And, um, what do you do there?"}
"r" and "q" are spoken one straight after the other, as a single turn: the learner hears "r" and then, with no pause, "q". So "q" picks up from where "r" ended. It does not start afresh, does not greet or react again, and does not repeat anything "r" already said. Read together, the two must sound like one person speaking once.`;

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

// The answer as the model writes it is as short as it can be (output tokens are the dearest and the slowest):
// short keys, one-letter values, and nothing written for what does not apply. Here it is read back into the
// full shape (Turn) the rest of the code uses.
//   h  what happened: a answered · h asked_for_help · c could_not · s something_else · g gave_up
//   p  picture: y named · n not_named        rd  reading: w well · p partly · n not        lv  level 1-4
//   ev evidence   tip [said, better]   n name   r reply   q question
//   f  the final level and feedback (its presence ends the talk): { lv, why, good: [..], next: [..], bye }
const CODES = {
  h: { a: 'answered', h: 'asked_for_help', c: 'could_not', s: 'something_else', g: 'gave_up' },
  p: { y: 'named', n: 'not_named' },
  rd: { w: 'well', p: 'partly', n: 'not' },
};
const codeOf = (map, word) => Object.keys(map).find((k) => map[k] === word);

/** A turn in the full shape → the short shape the model is asked to write (tests, the mock AI, the docs). */
export function toWire(t) {
  const f = t.final;
  return {
    h: codeOf(CODES.h, t.happened),
    ...(t.picture ? { p: codeOf(CODES.p, t.picture) } : {}), ...(t.reading ? { rd: codeOf(CODES.rd, t.reading) } : {}), ...(t.level != null ? { lv: t.level } : {}),
    ...(t.evidence ? { ev: t.evidence } : {}), ...(t.tip ? { tip: [t.tip.said, t.tip.better] } : {}), ...(t.name ? { n: t.name } : {}),
    r: t.reply, ...(t.question ? { q: t.question } : {}),
    ...(f ? { f: { lv: f.level, why: f.reason, good: f.doingWell, next: f.practise, bye: f.closing } } : t.finish ? { f: {} } : {}),
  };
}

/**
 * The model's answer → the full shape. Reads the short keys, and the long ones too (a model that ignores the
 * format, or an older answer); near-misses ("lv": "2", a tip as an object, words for letters) are mapped on.
 */
export function repairTurn(j) {
  if (!j || typeof j !== 'object') return j;
  const reply = j.r ?? j.reply;
  if (typeof reply !== 'string') return j; // not a turn at all: let it fail
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const nil = (v) => (v == null || /^(null|none|unknown|n\/a|-)?$/i.test(String(v).trim()) ? null : String(v).trim());
  // A letter of the short form, or the word itself.
  const oneOf = (v, map) => { const x = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'); return map[x] || (Object.values(map).includes(x) ? x : null); };
  const lvl = (v) => (Number.isFinite(Number(v)) && v != null && v !== '' ? Math.min(4, Math.max(1, Math.round(Number(v)))) : null);
  const list = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 4);
  const t = Array.isArray(j.tip) ? { said: j.tip[0], better: j.tip[1] } : j.tip && typeof j.tip === 'object' ? j.tip : null;
  const tip = t && str(t.said) && str(t.better) ? { said: str(t.said).slice(0, 200), better: str(t.better).slice(0, 200) } : null;
  const end = j.f ?? j.final, f = end && typeof end === 'object' && lvl(end.lv ?? end.level) ? end : null;
  return {
    // Older shape ("answered": true/false) and unknown words fall back to the nearest meaning.
    happened: oneOf(j.h ?? j.happened, CODES.h) || (j.answered === false ? 'asked_for_help' : 'answered'),
    picture: oneOf(j.p ?? j.picture, CODES.p), reading: oneOf(j.rd ?? j.reading, CODES.rd), level: lvl(j.lv ?? j.level),
    evidence: str(j.ev ?? j.evidence).slice(0, 400), tip, name: nil(j.n ?? j.name)?.slice(0, 40) ?? null,
    reply: str(reply).slice(0, 700), question: str(j.q ?? j.question).slice(0, 700),
    // "f" ends the talk; without a usable level in it the app's own rule decides the level.
    finish: !!(end && typeof end === 'object') || j.finish === true || j.finish === 'true',
    final: f && { level: lvl(f.lv ?? f.level), reason: str(f.why ?? f.reason).slice(0, 400), doingWell: list(f.good ?? f.doingWell), practise: list(f.next ?? f.practise), closing: str(f.bye ?? f.closing).slice(0, 600) },
  };
}

// How a turn is sent to the model. Two things make nearly all of every request reusable ("cached") by the
// provider, at a lower price:
//   1. Every rule is in the fixed instructions (BRAIN_SYSTEM), the same in every request of every talk.
//   2. The talk only ever GROWS. Whatever the app has to tell the model about this learner it says once, in a
//      short line of its own, and that line then stays in the talk for good. Nothing is rewritten or left out
//      later, so each request is the one before it plus what is new.
//   system     Sakhi's fixed instructions
//   user       "(The call begins.)"
//   assistant  what Sakhi said                                   ┐
//   system     [System] STEP: where the learner is now, …       │ one turn of the talk, kept as it happened
//   user       what the learner said                             │ (system lines: see lateSystemAsUser for the
//   system     [System] MEASURED: what the app counted in it    ┘ providers that take none in mid-talk)
//   …
// New in a request, so not yet reusable: Sakhi's last words (the model wrote them; they were never sent to it),
// the app's STEP line after them, the learner's reply, and the MEASURED line. Everything before is repeated
// exactly. On the next turn these too are part of what is repeated.
const START = '(The call begins.)';
const EVENT_TEXT = { no_speech: '(said nothing)', in_hindi: '(asked for the question in Hindi)', skip: '(asked to skip this)', repeat: '(asked to hear it again)', live_failed: '(could not be heard)' };
/** The learner's turn as it is kept in the talk: their words, or what they did instead. */
export const learnerLine = (event, transcript = '') => (event === 'answer' && transcript.trim() ? transcript.trim() : EVENT_TEXT[event] || EVENT_TEXT.live_failed);

/** A line from the server in the talk (not from the phone app, and not Sakhi's fixed instructions): never heard by the learner, never said by them. */
export const APP = '[System]';
export const appLine = (text) => `${APP} ${text}`;
/**
 * The line the app adds to the talk after a turn of Sakhi's that the learner talked over. Her turn itself is
 * kept whole. heard: the words of that turn they heard; rest: the words they did not; stillAnswering: the earlier
 * question they had not finished answering (they cut in before her next question).
 */
export function cutOffLine({ heard, rest }, stillAnswering = null) {
  return appLine(`CUT OFF: The learner started talking while you were still speaking. ${heard ? `They heard only: "${heard}"` : 'They heard none of it'}. They did not hear: "${rest}"${
    stillAnswering ? ` They were still answering your earlier question, "${stillAnswering}": everything they have said since it is ONE answer, in parts. This replaces what was recorded for its first part.` : ''}`);
}

/**
 * The talk as chat turns. history: [{ who: 'sakhi'|'learner'|'app', text }], only ever added to.
 * Sakhi's lines of one turn are one message; each line from the app is a system message of its own.
 */
export function talkTurns(history) {
  const out = [{ role: 'user', content: START }];
  let lastWho = null;
  for (const h of history) {
    if (h.who === lastWho && h.who !== 'app') out[out.length - 1].content += `\n${h.text}`;
    else out.push({ role: h.who === 'sakhi' ? 'assistant' : h.who === 'app' ? 'system' : 'user', content: h.text });
    lastWho = h.who;
  }
  return out;
}

/**
 * Everything sent for one turn (see above). ctx (built by the session, see conversation.js):
 *   history: the talk so far, the app's STEP line for this turn included
 *   line: the learner's new words, or what they did instead ("(said nothing)"), exactly as kept in the talk
 *   measured: the app's MEASURED line for those words, if there is one
 *   extra: one more line from the app for this request only (the final evaluation asked again). Never kept.
 */
export const turnMessages = (ctx) => [
  { role: 'system', content: BRAIN_SYSTEM }, ...talkTurns(ctx.history),
  { role: 'user', content: ctx.line },
  ...(ctx.measured ? [{ role: 'system', content: ctx.measured }] : []),
  ...(ctx.extra ? [{ role: 'system', content: ctx.extra }] : []),
];

/**
 * From the start of a JSON answer that is still being written: the fields up to and including `key`, as soon as
 * that field's text is complete. null until then.
 */
export function fieldsUpTo(text, key) {
  let depth = 0, inText = false, escaped = false, start = -1, current = null, value = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inText) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        inText = false;
        if (depth !== 1) continue;
        if (!value) { try { current = JSON.parse(text.slice(start, i + 1)); } catch { current = null; } continue; }
        value = false;
        if (current === key) { try { return JSON.parse(`${text.slice(0, i + 1)}}`); } catch { return null; } }
      }
    } else if (c === '"') { inText = true; start = i; }
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 1 && c === ':') value = true;
    else if (depth === 1 && c === ',') value = false;
  }
  return null;
}

/**
 * One turn of thinking. Changes nothing: the same ctx can be given to several models to compare them.
 * → { out: Turn, meta: { provider, model, latencyMs, usage, costInr, attempts, raw, thinking, firstTextMs, replyMs }, messages }; throws if the model fails.
 * onReply(part, ms): with a provider that streams, called once, as soon as her reply is written and before her
 * question and the rest are: part is the turn so far (what happened, the judgements, the name, the reply).
 */
export async function think(ctx, { config, structured = defaultStructured, timeoutMs = 9000, wantThinking = false, effort = null, onReply = null, fast = false } = {}) {
  const messages = turnMessages(ctx);
  const t0 = performance.now();
  let replyMs = null;
  const onText = onReply && ((text) => {
    if (replyMs != null) return;
    const part = fieldsUpTo(text, 'r') || fieldsUpTo(text, 'reply');
    if (!part || (part.h ?? part.happened) == null) return; // her reply, and what happened before it
    replyMs = Math.round(performance.now() - t0);
    const turn = Turn.safeParse(repairTurn(part)); // the fields still to come read as empty
    if (turn.success) onReply(turn.data, replyMs);
  });
  const r = await structured({ job: 'placement', config, schema: Turn, schemaName: 'sakhi_turn', repair: repairTurn, maxTokens: 700, timeoutMs, messages, wantThinking, effort, onText, fast,
    // The format is in the instructions, not a schema given to the provider: a provider's own schema makes the
    // model write every field every time (null when empty), which is most of what it would otherwise write.
    schemaToProvider: false });
  const { data, ...meta } = r;
  meta.replyMs = replyMs;
  // messages: what this provider was sent (the admin's log). Only OpenAI takes the app's lines as system messages in mid-talk.
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
