// Strategy B's check: a second, independent look at the corrections the tutor proposed, made only when there are
// any (most turns have none, so most turns cost one call either way). Precision first: if the check itself fails,
// the corrections are withheld (the learner still gets the reply) rather than shown unchecked.
import { VerifyOutput } from './schemas.js';
import { buildVerifyMessages } from './prompts.js';

/**
 * @returns {Promise<{kept: Array, dropped: Array<{correction, reason}>, call: object|null, error: string|null}>}
 */
export async function verifyCorrections({ structured, message, corrections, channel }) {
  if (!corrections.length) return { kept: [], dropped: [], call: null, error: null };
  let res;
  try {
    res = await structured({ job: 'verify', messages: buildVerifyMessages({ message, corrections, channel }), schema: VerifyOutput, schemaName: 'verify', maxTokens: 500 });
  } catch (e) {
    return { kept: [], dropped: corrections.map((correction) => ({ correction, reason: 'the check failed, so it was not shown' })), call: null, error: e.message };
  }
  const decision = new Map(res.data.decisions.map((d) => [d.index, d]));
  const kept = [], dropped = [];
  corrections.forEach((c, i) => {
    const d = decision.get(i);
    // No decision for a correction counts as "not confirmed".
    if (d?.keep) kept.push(c); else dropped.push({ correction: c, reason: d ? `check: ${d.reason || 'not confirmed'}` : 'check gave no decision' });
  });
  return { kept, dropped, call: { provider: res.provider, model: res.model, latencyMs: res.latencyMs, usage: res.usage, attempts: res.attempts }, error: null };
}
