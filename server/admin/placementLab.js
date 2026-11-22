// Comparing AI models for the conversation placement (admin console › Compare models). Each model runs its OWN
// conversation, end to end, side by side. You type what a learner says: it goes to every model's conversation,
// or to one of them (once their questions differ, each can be answered on its own). All of them start the same:
// the same picture and the same lines to read. Every turn goes to the model: for each you see what Sakhi says,
// what the model judged (what happened, the picture, the reading, the level, the fix), the speed, the tokens and
// the cost, and at the end the level it decided and its feedback.
// Nothing is saved.
//
//   GET  /api/admin/placement-lab           → { providers: { name: { configured } }, current, suggestions, prices, defaults }
//   POST /api/admin/placement-lab/start     { models: [{provider, model, temperature?, price?, turnEffort?, finalEffort?}, ..up to 4] }
//                                           → { labId, talks: [{ model, say, step, voice } | { model, error }] }
//   POST /api/admin/placement-lab/transcribe  (a WAV recording; ?language=en-IN for the reading step)
//                                           → { transcript, audioSec, ms }: Sarvam's speech-to-text, as in the app
//   POST /api/admin/placement-lab/turn      { labId, message?, event?, speechSec?, only?: index of one talk }
//                                           → { heard?, talks: [ null (not asked) | { model, say, step, voice, ai?, aiFailed?, log?, final?, done? } ] }
// final: { ai, log } when the final evaluation was asked for again with more thought (see conversation.js).
// heard, voice: what the turn would cost in the app besides the AI, at Sarvam's prices (server/costs.js):
//   heard { seconds, estimated, inr }: speech-to-text for the learner's words. seconds is the recording's length
//     when it was spoken into the page; for typed words it is estimated from their number.
//   voice { chars, fixedChars, inr }: Sakhi's voice for what she said. Her fixed lines are generated once, ahead
//     of time, and cost a talk nothing (fixedChars); the page itself plays no sound.
// log: the exact request (every message) and the model's answer as it came, with its thinking where the provider
// shares a summary of it.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as settings from '../settings.js';
import { providers, takesEffort } from '../llm/index.js';
import { listModels } from '../llm/models.js';
import { knownPrices } from '../llm/prices.js';
import { PRICES } from '../costs.js';
import * as sarvam from '../sarvam.js';
import * as conversation from '../placement/conversation.js';
import { readJson, readBody, send, fail } from '../http.js';

const Model = z.strictObject({
  provider: z.enum(['sarvam', 'openai', 'anthropic', 'gemini']),
  model: z.string().trim().min(1).max(100),
  temperature: z.number().min(0).max(1.5).default(0.6),
  // US dollars per million tokens, for a model whose price the server doesn't know (so its cost can be shown).
  // How hard this model thinks, on each turn and for the final level (OpenAI and Claude). Left out: the settings'.
  turnEffort: z.enum(settings.EFFORTS).optional(), finalEffort: z.enum(settings.EFFORTS).optional(),
  price: z.strictObject({ input: z.number().min(0).max(10_000), cached: z.number().min(0).max(10_000).optional(), output: z.number().min(0).max(10_000) }).optional(),
});
const Start = z.strictObject({ models: z.array(Model).min(1).max(4) });
const Turn = z.strictObject({
  labId: z.string().uuid(),
  message: z.string().max(2000).default(''),
  event: z.enum(['answer', 'no_speech', 'skip', 'in_hindi', 'repeat']).default('answer'),
  only: z.number().int().min(0).max(3).optional(),
  speechSec: z.number().min(0).max(600).optional(), // how long they spoke, when it came from the microphone
});
function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw fail(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
const efforts = (m) => (takesEffort(m.provider) ? { turn: m.turnEffort ?? settings.get('placement').turnEffort, final: m.finalEffort ?? settings.get('placement').finalEffort } : null);
// The same model can be in the comparison twice, with different thinking: the name then says which is which.
const label = (m) => `${m.provider}/${m.model}${takesEffort(m.provider) && (m.turnEffort || m.finalEffort) ? ` · thinking ${efforts(m).turn}/${efforts(m).final}` : ''}`;
const ready = (m) => !!providers[m.provider]?.configured();
const NOT_SET_UP = 'Not set up on the server: its API key is missing (deploy/llm-keys-setup.sh).';
/** Where a talk is: the step, and what's on the learner's screen. */
const stepOf = (s) => (s.done ? null : { step: s.q.step, ...(s.q.step === 'open' ? { n: s.q.n, level: s.q.target } : {}), ...(s.q.card ? { screen: s.q.card.text } : {}) });

// labId → { at, talks: [{ model, sessionId } | { model, error }] }. Two hours, like the conversations themselves.
const labs = new Map();
setInterval(() => { const now = Date.now(); for (const [id, l] of labs) if (now - l.at > 2 * 60 * 60 * 1000) labs.delete(id); }, 10 * 60 * 1000).unref();

// Sakhi's fixed lines: generated ahead and kept, so saying one costs a talk nothing.
let fixedLines = null;
const isFixed = (text) => (fixedLines ||= new Set(conversation.scriptedLines().map((l) => l.text))).has(text);
/** What Sakhi's voice for these lines would cost in the app. */
function voiceOf(lines) {
  const chars = lines.filter((l) => !isFixed(l.text)).reduce((n, l) => n + l.text.length, 0);
  return { chars, fixedChars: lines.reduce((n, l) => n + l.text.length, 0) - chars, inr: (chars / 10_000) * PRICES.ttsPer10kChars };
}
// A learner says about two words a second (used when the words were typed, so there is no recording to time).
const WORDS_A_SECOND = 2;
/** What speech-to-text for the learner's words would cost in the app. */
function heardOf(message, speechSec) {
  const estimated = !speechSec;
  const seconds = estimated ? Math.max(1, +(message.split(/\s+/).filter(Boolean).length / WORDS_A_SECOND).toFixed(1)) : speechSec;
  return { seconds, estimated, inr: (seconds / 3600) * PRICES.sttPerHour };
}

/** One model's conversation takes one learner turn. Never throws. */
async function takeTurn(talk, input, deps) {
  const s = conversation.getSession(talk.sessionId);
  if (!s) return { model: label(talk.model), error: 'This conversation has ended. Start again.' };
  const trace = { list: [], add(step, data) { this.list.push({ step, ...data }); } };
  let turn;
  try { turn = await conversation.handleTurn(s, input, trace, { config: talk.model, summaryConfig: talk.model, structured: deps.structured, timeoutMs: 20_000, detail: true, efforts: efforts(talk.model) || undefined }); }
  catch (e) { return { model: label(talk.model), error: e.message }; }
  const find = (step) => trace.list.find((x) => x.step === step);
  const brain = find('brain'), failed = find('brain-failed'), sum = find('summary'), exchange = find('exchange'), guard = trace.list.filter((x) => x.step === 'guard');
  const again = find('final-evaluation'), againLog = find('final-exchange'), againFailed = find('final-evaluation-failed');
  const logOf = (x) => ({ messages: x.messages, raw: x.raw, thinking: x.thinking, attempts: x.attempts });
  return {
    model: label(talk.model), say: turn.say.map((l) => l.text), step: stepOf(s), voice: voiceOf(turn.say),
    // What the AI judged on this turn, with its speed, tokens and cost.
    ...(brain ? { ai: { ms: brain.ms, firstTextMs: brain.firstTextMs, replyMs: brain.replyMs, costInr: brain.costInr, usage: brain.usage, effort: brain.effort, happened: brain.happened, picture: brain.picture, reading: brain.reading, level: brain.level, evidence: brain.evidence, tip: brain.tip, finish: brain.finish } } : {}),
    ...(failed ? { aiFailed: failed.why } : {}),
    // The exact request and the answer as it came (and the thinking, when the provider shares a summary).
    ...(exchange ? { log: logOf(exchange) } : {}),
    // The AI ended the talk on a lightly-thought turn: the final evaluation was asked for again, with more thought.
    ...(again ? { final: { ai: { ms: again.ms, costInr: again.costInr, usage: again.usage, effort: again.effort, level: again.final?.level ?? null, finish: again.finish }, ...(againLog ? { log: logOf(againLog) } : {}) } } : {}),
    ...(againFailed ? { finalFailed: againFailed.why } : {}),
    ...(guard.length ? { dropped: guard.map((g) => `${g.dropped}: ${g.why}`) } : {}),
    ...(turn.done ? { done: {
      level: turn.done.level, name: turn.done.name, decidedBy: turn.done.decidedBy, reasons: turn.done.reasons, doingWell: turn.done.doingWell, practise: turn.done.practise,
      // Only when the AI left the level out: the feedback then came from a second call.
      ...(sum ? { ai: { ms: sum.ms, costInr: sum.costInr, usage: sum.usage } } : {}),
    } } : {}),
  };
}

/** @param deps { structured } (tests) */
export async function handlePlacementLab(req, res, url, deps = {}) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/admin/placement-lab')) return false;

  if (m === 'GET' && p === '/api/admin/placement-lab') {
    return send(res, 200, {
      providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { configured: v.configured() }])),
      current: settings.get('placement'), effortFor: (({ turnEffort, finalEffort }) => ({ turn: turnEffort, final: finalEffort }))(settings.get('placement')), suggestions: await listModels(), // every model each provider offers now
      prices: knownPrices(), // US dollars per million tokens, for the models whose price is known
      speechPrices: { sttPerHour: PRICES.sttPerHour, ttsPer10kChars: PRICES.ttsPer10kChars, asOf: PRICES.asOf, wordsASecond: WORDS_A_SECOND }, // rupees, Sarvam
      // What the page compares unless told otherwise: the model in use, and OpenAI's small fast model beside it.
      defaults: [settings.get('placement').brain, { provider: 'openai', model: 'gpt-6-luna' }].filter((m, i, a) => a.findIndex((x) => x.provider === m.provider && x.model === m.model) === i).map(({ provider, model }) => ({ provider, model })),
    }), true;
  }

  if (m === 'POST' && p === '/api/admin/placement-lab/start') {
    const b = parse(Start, await readJson(req));
    if (!b.models.some(ready)) throw fail(400, `None of these models is set up on the server. ${NOT_SET_UP}`);
    // The same picture, reading line and first open question in every talk, so the models can be compared.
    const seed = Math.floor(Math.random() * 1e6);
    const lab = { at: Date.now(), talks: [] }, out = [];
    for (const model of b.models) {
      if (!ready(model)) { lab.talks.push({ model, error: NOT_SET_UP }); out.push({ model: label(model), error: NOT_SET_UP }); continue; }
      const t = conversation.startSession({ lab: true, seed });
      const s = conversation.getSession(t.sessionId);
      lab.talks.push({ model, sessionId: s.id });
      out.push({ model: label(model), say: t.say.map((l) => l.text), step: stepOf(s), voice: voiceOf(t.say) });
    }
    const labId = randomUUID();
    labs.set(labId, lab);
    return send(res, 200, { labId, talks: out }), true;
  }

  if (m === 'POST' && p === '/api/admin/placement-lab/transcribe') {
    // What a learner says into the microphone, turned into words by Sarvam exactly as in the app.
    const wav = await readBody(req, 1_200_000); // Sarvam takes up to 30 seconds (16 kHz, 16-bit, one channel)
    if (wav.length < 2000) throw fail(400, 'That recording is empty. Hold the microphone button and speak.');
    const language = url.searchParams.get('language');
    const t0 = performance.now();
    let r;
    try { r = await sarvam.transcribe(wav, language === 'en-IN' ? { language_code: 'en-IN' } : {}); }
    catch (e) { throw fail(502, `Speech-to-text failed: ${e.message}`); }
    return send(res, 200, { transcript: r.transcript.trim(), languageCode: r.languageCode, audioSec: +((wav.length - 44) / 32000).toFixed(1), ms: Math.round(performance.now() - t0) }), true;
  }

  if (m === 'POST' && p === '/api/admin/placement-lab/turn') {
    const b = parse(Turn, await readJson(req));
    const lab = labs.get(b.labId);
    if (!lab) throw fail(404, 'That comparison has ended (they last two hours). Start a new one.');
    lab.at = Date.now();
    const input = { event: b.event, transcript: b.event === 'answer' ? b.message.trim() : '', speechSec: b.speechSec || 0 };
    if (b.event === 'answer' && !input.transcript) throw fail(400, 'Type what the learner says.');
    // Every talk that is still going (or just the one asked for) takes the turn, at the same time.
    const talks = await Promise.all(lab.talks.map((talk, i) => {
      if (talk.error || (b.only != null && b.only !== i)) return null;
      const s = conversation.getSession(talk.sessionId);
      return s && !s.done ? takeTurn(talk, input, deps) : null;
    }));
    if (!talks.some(Boolean)) throw fail(409, b.only != null ? 'That conversation has finished.' : 'Every conversation has finished. Start again.');
    return send(res, 200, { talks, ...(b.event === 'answer' ? { heard: heardOf(input.transcript, b.speechSec) } : {}) }), true;
  }
  throw fail(404, 'not found');
}
