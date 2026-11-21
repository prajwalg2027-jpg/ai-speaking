// Comparing AI models for the conversation placement (admin console › Compare models). You type what a learner
// says. One model (the "primary") drives a real conversation placement; the others are given exactly the same
// turn and their answers are shown beside it: what Sakhi would say, the level they give, how long they took and
// what it cost. At the end each model also writes the closing feedback. Nothing is saved.
//
//   GET  /api/admin/placement-lab           → { providers: { name: { configured } }, current, suggestions }
//   POST /api/admin/placement-lab/start     { primary: {provider, model, temperature?}, others: [..up to 3] }
//                                           → { labId, say: [lines], question: { n, level }, models }
//   POST /api/admin/placement-lab/turn      { labId, message?, event?: 'answer'|'no_speech'|'skip'|'in_hindi'|'repeat' }
//                                           → { say, question, primary: {...}, others: [...], ratings, done? }
import { z } from 'zod';
import * as settings from '../settings.js';
import { providers } from '../llm/index.js';
import { isUnintelligible } from '../clarify.js';
import * as conversation from '../placement/conversation.js';
import { think, summarize } from '../placement/brain.js';
import { readJson, send, fail } from '../http.js';

// Starting points for the model box (any model name the provider accepts can be typed).
const SUGGESTIONS = {
  sarvam: ['sarvam-105b-conversations', 'sarvam-105b'],
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  openai: [], gemini: [],
};

const Model = z.strictObject({
  provider: z.enum(['sarvam', 'openai', 'anthropic', 'gemini']),
  model: z.string().trim().min(1).max(100),
  temperature: z.number().min(0).max(1.5).default(0.6),
});
const Start = z.strictObject({ primary: Model, others: z.array(Model).max(3).default([]) });
const Turn = z.strictObject({
  labId: z.string().uuid(),
  message: z.string().max(2000).default(''),
  event: z.enum(['answer', 'no_speech', 'skip', 'in_hindi', 'repeat']).default('answer'),
});
function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw fail(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
const label = (m) => `${m.provider}/${m.model}`;
const ready = (m) => !!providers[m.provider]?.configured();
const NOT_SET_UP = 'Not set up on the server: its API key is missing (deploy/llm-keys-setup.sh).';

/** One model's answer to a turn, or why there isn't one. Never throws. */
async function tryThink(ctx, m, deps) {
  if (!ready(m)) return { model: label(m), error: NOT_SET_UP };
  try {
    const { out, meta } = await think(ctx, { config: m, structured: deps.structured, timeoutMs: 20_000 });
    return { model: label(m), ms: meta.latencyMs, costInr: meta.costInr ?? null, attempts: meta.attempts, ...out };
  } catch (e) { return { model: label(m), error: e.message }; }
}

/** @param deps { structured } (tests) */
export async function handlePlacementLab(req, res, url, deps = {}) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/admin/placement-lab')) return false;

  if (m === 'GET' && p === '/api/admin/placement-lab') {
    return send(res, 200, {
      providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { configured: v.configured() }])),
      current: settings.get('placement'), suggestions: SUGGESTIONS,
    }), true;
  }

  if (m === 'POST' && p === '/api/admin/placement-lab/start') {
    const b = parse(Start, await readJson(req));
    if (!ready(b.primary)) throw fail(400, `${b.primary.provider}: ${NOT_SET_UP}`);
    const t = conversation.startSession({ lab: true });
    const s = conversation.getSession(t.sessionId);
    s.labModels = b;
    return send(res, 200, {
      labId: s.id, say: t.say.map((l) => l.text), question: { n: s.q.n, level: s.q.target },
      models: [b.primary, ...b.others].map((x) => ({ model: label(x), configured: ready(x) })),
    }), true;
  }

  if (m === 'POST' && p === '/api/admin/placement-lab/turn') {
    const b = parse(Turn, await readJson(req));
    const s = conversation.getSession(b.labId);
    if (!s?.lab) throw fail(404, 'That comparison has ended (they last two hours). Start a new one.');
    if (s.done) throw fail(409, 'This conversation has finished. Start a new one.');
    const { primary, others } = s.labModels;
    const input = { event: b.event, transcript: b.event === 'answer' ? b.message.trim() : '', speechSec: 0 };
    if (b.event === 'answer' && !input.transcript) throw fail(400, 'Type what the learner says.');
    // The same turn for every model: built before the primary's answer changes the conversation.
    const thinks = b.event !== 'repeat' && !(b.event === 'answer' && isUnintelligible(input.transcript));
    const ctx = thinks ? conversation.buildCtx(s, input) : null;
    const trace = { list: [], add(step, data) { this.list.push({ step, ...data }); } };
    const [turn, alts] = await Promise.all([
      conversation.handleTurn(s, input, trace, { config: primary, summaryConfig: primary, structured: deps.structured }),
      ctx ? Promise.all(others.map((x) => tryThink(ctx, x, deps))) : [],
    ]);
    const brain = trace.list.find((x) => x.step === 'brain'), failed = trace.list.find((x) => x.step === 'brain-failed');
    const rated = trace.list.find((x) => x.step === 'rated');
    const out = {
      say: turn.say.map((l) => l.text),
      question: turn.task ? { n: s.q.n, level: s.q.target } : null,
      primary: {
        model: label(primary), ...(brain ? { ms: brain.ms, costInr: brain.costInr, answered: brain.answered, level: brain.level, evidence: brain.evidence, tip: brain.tip, reply: brain.reply, question: brain.question } : {}),
        ...(failed ? { error: failed.why } : {}),
        counted: rated ? { level: rated.level, ...(rated.missed ? { missed: true } : {}) } : null, // the level after the measured checks
      },
      others: alts,
      ratings: s.ratings.map((r) => ({ level: r.level, asked: r.target, englishWords: r.englishWords, ...(r.missed ? { missed: true } : {}) })),
    };
    if (turn.done) {
      const said = s.answers.filter((a) => !a.skipped).map((a) => ({ transcript: a.transcript, level: a.rated, evidence: a.evidence, tip: a.tip }));
      const sum = trace.list.find((x) => x.step === 'summary');
      out.done = {
        level: turn.done.level, name: turn.done.name, reasons: turn.done.reasons,
        primary: { model: label(primary), ms: sum?.ms ?? null, doingWell: turn.done.doingWell, practise: turn.done.practise, ...(sum?.fallback ? { fallback: sum.fallback } : {}) },
        others: await Promise.all(others.map(async (x) => {
          if (!ready(x)) return { model: label(x), error: NOT_SET_UP };
          const r = await summarize({ answers: said, level: turn.done.level }, { config: x, structured: deps.structured, timeoutMs: 20_000 });
          return { model: label(x), ms: r.meta?.latencyMs ?? null, costInr: r.meta?.costInr ?? null, doingWell: r.doingWell, practise: r.practise, closing: r.closing, ...(r.fallback ? { fallback: r.fallback } : {}) };
        })),
      };
    }
    return send(res, 200, out), true;
  }
  throw fail(404, 'not found');
}
