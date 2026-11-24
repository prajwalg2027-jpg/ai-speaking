// The result screen's detailed feedback ("insights"): what the learner can learn from their own answers, written
// once the test has ended, in ONE AI call that starts while Sakhi says goodbye (so her last turn is not slowed).
// The app asks for it with GET /api/session/insights and shows it under the level.
//
// What it holds (all of it is optional: a part the AI got wrong is dropped, never shown):
//   answers  each answer, said the right way (a word-by-word diff against what they said), why, and the same
//            idea the way someone one level up would say it
//   best     their strongest sentence, quoted, with what makes it strong
//   ladder   one idea of theirs said at each of the four levels; theirs is marked
//   habit    a mistake that came up in two or more places, with each example and a rule
//   tip      a common Indian English pattern they used, explained (with a Hindi line)
//   counts   counted by the app, not the AI: English words, the longest answer, joining words, Hindi words
// The sentences in "answers" and "habit" are the ones the learner can hear and say back (POST /api/session/sayback).
import { z } from 'zod';
import { structured as defaultStructured } from '../llm/index.js';
import { normalizeForCompare } from '../normalize.js';
import { readAccuracy } from '../scoring.js';

const LEVEL_WORDS = { 1: 'a beginner', 2: 'basic', 3: 'good', 4: 'very good' };
const ADDS = ['joining word', 'past tense', 'a reason', 'richer words', 'more detail', 'an extra idea', 'natural phrase'];
const TAGS = ['gave a reason', 'talked about the past', 'talked about the future', 'joined two ideas', 'used a describing word', 'full sentence', 'natural phrase', 'gave an example'];

export const INSIGHTS_SYSTEM = `You write the result page for a learner who has just finished a short spoken English check with Sakhi, a warm English tutor in India. They will read it on their phone right after hearing their level. Its job: teach them something real and specific from their OWN answers.
Use very simple English for levels 1 and 2, simple English for 3 and 4. Talk to them as "you". Never use the words "fluency", "vocabulary", "grammar", "coherence", "comprehension" or "pronunciation", and no scores. Use single quotes inside sentences, never double quotes. Base everything on what they actually said (the speech-to-text may have small errors: never correct a word that is likely a mishearing, like a name).

Reply with ONLY this JSON (leave out a key that does not apply):
{"answers": [{"i": 1, "better": "...", "why": "...", "up": "...", "upAdds": ["..."]}],
 "best": {"i": 2, "quote": "...", "tags": ["..."], "why": "..."},
 "ladder": ["level 1 way", "level 2 way", "level 3 way", "level 4 way"],
 "habit": {"name": "...", "rule": "...", "examples": [{"said": "...", "better": "..."}]},
 "tip": {"title": "...", "said": "...", "better": "...", "rule": "...", "hindi": "..."}}

- answers: one for EVERY answer, by its number i.
  - better: their whole answer said correctly and naturally, at THEIR level: keep their idea and as many of their own words as you can, and change only what is wrong or very unnatural. If it is already right, write it back exactly as they said it.
  - why: one short sentence on the main change, in everyday words (It already happened, so 'go' becomes 'went'.). Leave it out if nothing changed.
  - up: the same idea, said the way someone ONE level higher would say it (for level 4: how a confident, natural speaker would say it). One to three sentences, still easy to say out loud.
  - upAdds: one to three labels for what "up" adds, only from: ${ADDS.map((a) => `'${a}'`).join(', ')}.
- best: their single strongest sentence, copied EXACTLY from their words (one sentence; you may leave out words before or after it). tags: one to three, only from: ${TAGS.map((a) => `'${a}'`).join(', ')}. why: one short sentence on what makes it good.
- ladder: take the one idea of theirs that best shows their level, and say it four times, as a level 1, 2, 3 and 4 speaker would: 1 is two or three words; 2 is a short simple sentence that may have small mistakes; 3 is a few connected sentences with a reason; 4 is fluent and rich. The one for THEIR level should be close to what they actually said.
- habit: only if the SAME kind of mistake happened in at least two places. name: under 7 words (Leaving out 'the' and 'a'). rule: one sentence. examples: two or three, "said" copied exactly from their words (just the few words around the mistake), "better" the same words corrected.
- tip: only if they used a common Indian English pattern, such as 'since two months' (for two months), 'I am having a car' (I have a car), 'do one thing', 'revert back', 'discuss about', 'cousin brother', 'I am knowing', 'today morning' (this morning), 'one of my friend', 'he is having fever'. title: a short question or name ('since' or 'for'?). said: their exact words; better: the natural way; rule: one short sentence; hindi: the same rule in one short line of simple Hindi (Devanagari).`;

const Answer = z.object({ i: z.number().int(), better: z.string().max(600), why: z.string().max(300).optional(), up: z.string().max(700).optional(), upAdds: z.array(z.string().max(40)).max(5).optional() });
export const Insights = z.object({
  answers: z.array(Answer).max(8).optional(),
  best: z.object({ i: z.number().int().optional(), quote: z.string().max(400), tags: z.array(z.string().max(40)).max(5).optional(), why: z.string().max(300).optional() }).optional(),
  ladder: z.array(z.string().max(400)).max(6).optional(),
  habit: z.object({ name: z.string().max(80), rule: z.string().max(300), examples: z.array(z.object({ said: z.string().max(200), better: z.string().max(200) })).max(5) }).optional(),
  tip: z.object({ title: z.string().max(80), said: z.string().max(200), better: z.string().max(200), rule: z.string().max(300), hindi: z.string().max(300).optional() }).optional(),
});

/** Near-misses (null for "not this", a number as text) are read as what the model meant. */
function repair(j) {
  if (!j || typeof j !== 'object') return j;
  const o = {};
  for (const [k, v] of Object.entries(j)) if (v != null && v !== '') o[k] = v;
  if (Array.isArray(o.answers)) o.answers = o.answers.filter((a) => a && typeof a === 'object').map((a) => {
    const x = {}; for (const [k, v] of Object.entries(a)) if (v != null && v !== '') x[k] = v;
    return { ...x, i: Number(x.i) };
  });
  if (o.best && typeof o.best === 'object' && o.best.i != null) o.best = { ...o.best, i: Number(o.best.i) };
  for (const k of ['best', 'habit', 'tip']) if (o[k] && typeof o[k] !== 'object') delete o[k];
  if (o.tip && o.tip.hindi == null) delete o.tip.hindi;
  return o;
}

const BANNED = /\b(fluency|vocabulary|grammar|coherence|comprehension|pronunciation)\b/i;
const ok = (t, max = 60) => typeof t === 'string' && t.trim() && !BANNED.test(t) && t.trim().split(/\s+/).length <= max;
const norm = (t) => normalizeForCompare(t).join(' ');
/** Are these words (normalised) somewhere in what they said? */
const inTheirWords = (part, transcripts) => { const p = norm(part); return !!p && transcripts.some((t) => ` ${norm(t)} `.includes(` ${p} `)); };
const tidy = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/**
 * A word-by-word difference between what they said and a better way: [{ t, k }], k 'same' | 'del' | 'add'.
 * Words are compared without case or punctuation; shown as written.
 */
export function wordDiff(from, to) {
  const a = tidy(from).split(' ').filter(Boolean), b = tidy(to).split(' ').filter(Boolean);
  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const ka = a.map(key), kb = b.map(key);
  const L = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = ka[i] === kb[j] && ka[i] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  const push = (t, k) => { const last = out.at(-1); if (last && last.k === k && k !== 'same') last.t += ` ${t}`; else out.push({ t, k }); };
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j] && ka[i]) { push(b[j], 'same'); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push(a[i++], 'del');
    else push(b[j++], 'add');
  }
  while (i < a.length) push(a[i++], 'del');
  while (j < b.length) push(b[j++], 'add');
  // A run of "same" words is joined too, so the app gets a few pieces, not one per word.
  return out.reduce((acc, p) => { const last = acc.at(-1); if (last && last.k === 'same' && p.k === 'same') last.t += ` ${p.t}`; else acc.push({ ...p }); return acc; }, []);
}

const JOINING = ['and', 'but', 'because', 'so', 'then', 'when', 'if', 'or', 'after', 'before', 'while', 'although', 'also', 'which', 'that'];
const HINDI_LATIN = new Set('hai hain nahi nahin kya bahut aur mein mai ka ki ke ko toh haan accha acha theek thik matlab kyunki lekin phir abhi bhi yaar ji'.split(' '));

/** Counted by the app from their answers (no AI): what the result screen shows under "What you said, counted". */
export function countsOf(transcripts) {
  const tokens = transcripts.map((t) => tidy(t).split(' ').filter(Boolean));
  const latin = (w) => /^[a-z'-]+$/i.test(w.replace(/[.,!?;:"]/g, ''));
  const clean = (w) => w.toLowerCase().replace(/[^a-z'-]/g, '');
  const english = tokens.map((ws) => ws.filter((w) => latin(w) && !HINDI_LATIN.has(clean(w))));
  const joined = new Set();
  for (const ws of english) for (const w of ws) { const c = clean(w); if (JOINING.includes(c) && !['that', 'which'].includes(c)) joined.add(c); }
  const hindi = tokens.flat().filter((w) => /[ऀ-ॿ]/.test(w) || HINDI_LATIN.has(clean(w))).length;
  return {
    answers: transcripts.length,
    englishWords: english.reduce((n, ws) => n + ws.length, 0),
    longestAnswer: english.reduce((n, ws) => Math.max(n, ws.length), 0),
    joiningWords: JOINING.filter((w) => joined.has(w)),
    hindiWords: hindi,
  };
}

/**
 * The answers the feedback is about: the open answers of a conversation test, or the spoken answers of the
 * classic test (not the reading, the word or listening tasks). → [{ question, transcript, tip }]
 */
export function answersOf(s) {
  const spoken = (a) => !a.skipped && tidy(a.transcript).split(' ').filter((w) => /[a-z]/i.test(w)).length >= 3;
  return (s.answers || []).filter((a) => a.kind === 'open' && spoken(a)).slice(-6)
    .map((a) => ({ question: tidy(a.question || ''), transcript: tidy(a.transcript), tip: a.tip || null }));
}

/** Only the parts of the AI's answer that hold up: in their own words where they must be, simple, and complete. */
export function usableInsights(data, answers, level) {
  const transcripts = answers.map((a) => a.transcript);
  const out = {};
  const list = (data.answers || []).filter((a) => a.i >= 1 && a.i <= answers.length && ok(a.better, 90));
  const seen = new Set();
  out.answers = list.filter((a) => !seen.has(a.i) && seen.add(a.i)).sort((x, y) => x.i - y.i).map((a) => {
    const said = answers[a.i - 1].transcript, better = tidy(a.better);
    const same = norm(said) === norm(better);
    const up = ok(a.up, 90) && norm(a.up) !== norm(better) ? tidy(a.up) : null;
    return {
      i: a.i, question: answers[a.i - 1].question, said, better, same, diff: wordDiff(said, better),
      why: !same && ok(a.why, 30) ? tidy(a.why) : null,
      up, upDiff: up ? wordDiff(better, up) : [], upAdds: up ? (a.upAdds || []).filter((x) => ADDS.includes(x)).slice(0, 3) : [],
    };
  });
  const b = data.best;
  if (b && ok(b.quote, 50) && inTheirWords(b.quote, transcripts) && normalizeForCompare(b.quote).length >= 3) {
    out.best = { quote: tidy(b.quote).replace(/^["']|["']$/g, ''), tags: (b.tags || []).filter((t) => TAGS.includes(t)).slice(0, 3), why: ok(b.why, 30) ? tidy(b.why) : null };
  }
  if (Array.isArray(data.ladder) && data.ladder.length === 4 && data.ladder.every((x) => ok(x, 70))) {
    out.ladder = { you: level, rungs: data.ladder.map((text, k) => ({ level: k + 1, text: tidy(text) })) };
  }
  const h = data.habit;
  if (h && ok(h.name, 8) && ok(h.rule, 30)) {
    const examples = h.examples.filter((e) => ok(e.said, 25) && ok(e.better, 25) && inTheirWords(e.said, transcripts) && norm(e.said) !== norm(e.better))
      .map((e) => ({ said: tidy(e.said), better: tidy(e.better), diff: wordDiff(e.said, e.better) })).slice(0, 3);
    if (examples.length >= 2) out.habit = { name: tidy(h.name), rule: tidy(h.rule), examples };
  }
  const t = data.tip;
  if (t && ok(t.title, 10) && ok(t.said, 20) && ok(t.better, 20) && ok(t.rule, 30) && inTheirWords(t.said, transcripts) && norm(t.said) !== norm(t.better)) {
    out.tip = { title: tidy(t.title), said: tidy(t.said), better: tidy(t.better), rule: tidy(t.rule), hindi: t.hindi && /[ऀ-ॿ]/.test(t.hindi) ? tidy(t.hindi) : null };
  }
  if (!out.answers.length) delete out.answers;
  return out;
}

/** The sentences on the result screen that the learner may hear and say back. */
export function sayable(ins) {
  const all = [...(ins.answers || []).flatMap((a) => [a.better, a.up]), ...(ins.habit?.examples || []).map((e) => e.better), ins.tip?.better];
  return [...new Set(all.filter(Boolean))];
}

/**
 * The detailed feedback for a finished test. Never throws: with no answers to talk about, or if the AI fails,
 * it holds only the counts (and why the rest is missing).
 * → { status: 'ready', level, counts, answers?, best?, ladder?, habit?, tip?, meta?, fallback? }
 */
export async function buildInsights(s, { config, structured = defaultStructured, timeoutMs = 25_000, effort = null } = {}) {
  const answers = answersOf(s), level = s.result?.level || 2;
  const base = { status: 'ready', level, counts: countsOf(answers.map((a) => a.transcript)) };
  if (!answers.length) return { ...base, fallback: 'no spoken answers' };
  const user = [
    `THEIR LEVEL: ${level} (${LEVEL_WORDS[level]}).`,
    `THEIR ANSWERS (speech-to-text):\n${answers.map((a, k) => `${k + 1}. Sakhi asked: ${a.question || '(a question about their life)'}\n   They said: ${a.transcript}`).join('\n')}`,
    answers.some((a) => a.tip) ? `FIXES SAKHI ALREADY MADE IN THE TALK:\n${answers.filter((a) => a.tip).map((a) => `- '${a.tip.said}' → '${a.tip.better}'`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  try {
    const { data, ...meta } = await structured({
      job: 'placementSummary', config, schema: Insights, schemaName: 'sakhi_insights', repair, maxTokens: 1800, timeoutMs, effort,
      messages: [{ role: 'system', content: INSIGHTS_SYSTEM }, { role: 'user', content: user }],
    });
    return { ...base, ...usableInsights(data, answers, level), meta: { provider: meta.provider, model: meta.model, ms: meta.latencyMs, costInr: meta.costInr ?? null } };
  } catch (e) {
    return { ...base, fallback: e.message };
  }
}

/**
 * How well they said a sentence back: each of its words, heard or not, and the share of the sentence matched.
 * → { heard, score (0..1), matched, total, words: [{ t, ok }] }
 */
export function sayBackScore(target, heard) {
  const shown = tidy(target).split(' ').filter(Boolean);
  const keys = shown.map((w) => norm(w));
  const h = normalizeForCompare(heard);
  // Longest common run of words, in order: a word counts as said if it lines up with one they said.
  const L = Array.from({ length: keys.length + 1 }, () => Array(h.length + 1).fill(0));
  const eq = (k, w) => !!k && (k === w || k.split(' ').includes(w));
  for (let i = keys.length - 1; i >= 0; i--) for (let j = h.length - 1; j >= 0; j--) L[i][j] = eq(keys[i], h[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const okAt = new Set();
  for (let i = 0, j = 0; i < keys.length && j < h.length;) {
    if (eq(keys[i], h[j])) { okAt.add(i); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  const words = shown.map((t, i) => ({ t, ok: okAt.has(i) || !keys[i] }));
  return { heard: tidy(heard), score: +readAccuracy(target, heard).toFixed(2), matched: words.filter((w) => w.ok).length, total: words.length, words };
}
