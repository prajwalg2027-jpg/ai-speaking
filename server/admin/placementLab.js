// Comparing AI models for the conversation placement (admin console › Compare models). Each model runs its OWN
// conversation, end to end, side by side. You type what a learner says: it goes to every model's conversation,
// or to one of them (once their questions differ, each can be answered on its own). All of them start the same:
// the same picture and the same lines to read. Every turn goes to the model: for each you see what Sakhi says,
// what the model judged (what happened, the picture, the reading, the level, the fix), the speed, the tokens and
// the cost, and at the end the level it decided and its feedback.
// Nothing is saved.
//
//   GET  /api/admin/placement-lab           → { providers: { name: { configured } }, current, suggestions }
//   POST /api/admin/placement-lab/start     { models: [{provider, model, temperature?, price?}, ..up to 4] }
//                                           → { labId, talks: [{ model, say, step } | { model, error }] }
//   POST /api/admin/placement-lab/turn      { labId, message?, event?, only?: index of one talk }
//                                           → { talks: [ null (not asked) | { model, say, step, ai?, aiFailed?, done? } ] }
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as settings from '../settings.js';
import { providers } from '../llm/index.js';
import { listModels } from '../llm/models.js';
import * as conversation from '../placement/conversation.js';
import { readJson, send, fail } from '../http.js';

const Model = z.strictObject({
  provider: z.enum(['sarvam', 'openai', 'anthropic', 'gemini']),
  model: z.string().trim().min(1).max(100),
  temperature: z.number().min(0).max(1.5).default(0.6),
  // US dollars per million tokens, for a model whose price the server doesn't know (so its cost can be shown).
  price: z.strictObject({ input: z.number().min(0).max(10_000), cached: z.number().min(0).max(10_000).optional(), output: z.number().min(0).max(10_000) }).optional(),
});
const Start = z.strictObject({ models: z.array(Model).min(1).max(4) });
const Turn = z.strictObject({
  labId: z.string().uuid(),
  message: z.string().max(2000).default(''),
  event: z.enum(['answer', 'no_speech', 'skip', 'in_hindi', 'repeat']).default('answer'),
  only: z.number().int().min(0).max(3).optional(),
});
function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw fail(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
const label = (m) => `${m.provider}/${m.model}`;
const ready = (m) => !!providers[m.provider]?.configured();
const NOT_SET_UP = 'Not set up on the server: its API key is missing (deploy/llm-keys-setup.sh).';
/** Where a talk is: the step, and what's on the learner's screen. */
const stepOf = (s) => (s.done ? null : { step: s.q.step, ...(s.q.step === 'open' ? { n: s.q.n, level: s.q.target } : {}), ...(s.q.card ? { screen: s.q.card.text } : {}) });

// labId → { at, talks: [{ model, sessionId } | { model, error }] }. Two hours, like the conversations themselves.
const labs = new Map();
setInterval(() => { const now = Date.now(); for (const [id, l] of labs) if (now - l.at > 2 * 60 * 60 * 1000) labs.delete(id); }, 10 * 60 * 1000).unref();

/** One model's conversation takes one learner turn. Never throws. */
async function takeTurn(talk, input, deps) {
  const s = conversation.getSession(talk.sessionId);
  if (!s) return { model: label(talk.model), error: 'This conversation has ended. Start again.' };
  const trace = { list: [], add(step, data) { this.list.push({ step, ...data }); } };
  let turn;
  try { turn = await conversation.handleTurn(s, input, trace, { config: talk.model, summaryConfig: talk.model, structured: deps.structured, timeoutMs: 20_000 }); }
  catch (e) { return { model: label(talk.model), error: e.message }; }
  const find = (step) => trace.list.find((x) => x.step === step);
  const brain = find('brain'), failed = find('brain-failed'), sum = find('summary'), guard = trace.list.filter((x) => x.step === 'guard');
  return {
    model: label(talk.model), say: turn.say.map((l) => l.text), step: stepOf(s),
    // What the AI judged on this turn, with its speed, tokens and cost.
    ...(brain ? { ai: { ms: brain.ms, costInr: brain.costInr, usage: brain.usage, happened: brain.happened, picture: brain.picture, reading: brain.reading, level: brain.level, evidence: brain.evidence, tip: brain.tip, finish: brain.finish } } : {}),
    ...(failed ? { aiFailed: failed.why } : {}),
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
      current: settings.get('placement'), suggestions: await listModels(), // every model each provider offers now
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
      out.push({ model: label(model), say: t.say.map((l) => l.text), step: stepOf(s) });
    }
    const labId = randomUUID();
    labs.set(labId, lab);
    return send(res, 200, { labId, talks: out }), true;
  }

  if (m === 'POST' && p === '/api/admin/placement-lab/turn') {
    const b = parse(Turn, await readJson(req));
    const lab = labs.get(b.labId);
    if (!lab) throw fail(404, 'That comparison has ended (they last two hours). Start a new one.');
    lab.at = Date.now();
    const input = { event: b.event, transcript: b.event === 'answer' ? b.message.trim() : '', speechSec: 0 };
    if (b.event === 'answer' && !input.transcript) throw fail(400, 'Type what the learner says.');
    // Every talk that is still going (or just the one asked for) takes the turn, at the same time.
    const talks = await Promise.all(lab.talks.map((talk, i) => {
      if (talk.error || (b.only != null && b.only !== i)) return null;
      const s = conversation.getSession(talk.sessionId);
      return s && !s.done ? takeTurn(talk, input, deps) : null;
    }));
    if (!talks.some(Boolean)) throw fail(409, b.only != null ? 'That conversation has finished.' : 'Every conversation has finished. Start again.');
    return send(res, 200, { talks }), true;
  }
  throw fail(404, 'not found');
}
