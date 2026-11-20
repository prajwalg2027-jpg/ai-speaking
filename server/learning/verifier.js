// Strategy B's check: a second, independent look at the corrections the tutor proposed, made only when there are
// any (most turns have none, so most turns cost one call either way). Precision first: if the check itself fails,
// the corrections are withheld (the learner still gets the reply) rather than shown unchecked.
import { VerifyOutput, repairVerifyOutput } from './schemas.js';
import { buildVerifyMessages } from './prompts.js';

/**
 * @returns {Promise<{kept: Array, dropped: Array<{correction, reason}>, call: object|null, error: string|null}>}
 */
export async function verifyCorrections({ structured, message, corrections, channel }) {
  if (!corrections.length) return { kept: [], dropped: [], call: null, error: null };
  let res;
  try {
    res = await structured({ job: 'verify', messages: buildVerifyMessages({ message, corrections, channel }), schema: VerifyOutput, schemaName: 'verify', repair: repairVerifyOutput, maxTokens: 500 });
  } catch (e) {
    return { kept: [], dropped: corrections.map((correction) => ({ correction, reason: 'the check failed, so it was not shown' })), call: null, error: e.message };
  }
  const pickFor = matchDecisions(corrections, res.data.decisions);
  const kept = [], dropped = [];
  corrections.forEach((c, i) => {
    const d = pickFor[i];
    // No decision for a correction counts as "not confirmed": precision first.
    if (d?.verdict === 'real_mistake') kept.push(c);
    else dropped.push({ correction: c, reason: d ? `check: ${d.verdict === 'bad_fix' ? 'the fix is wrong' : 'not a mistake'}${d.reason ? ` (${d.reason})` : ''}` : 'check gave no decision' });
  });
  return { kept, dropped, call: { provider: res.provider, model: res.model, latencyMs: res.latencyMs, usage: res.usage, attempts: res.attempts }, error: null };
}

const n = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
/**
 * Which decision belongs to which correction. Models sometimes number from 1, or skip numbers: match by the echoed
 * words first, then by the number (0-based, or 1-based when that's clearly what was used), then by position.
 * → decisions in the order of `corrections` (undefined where there's none)
 */
export function matchDecisions(corrections, decisions) {
  const out = new Array(corrections.length), used = new Set();
  corrections.forEach((c, i) => {
    const j = decisions.findIndex((d, k) => !used.has(k) && d.original && n(d.original) === n(c.original));
    if (j >= 0) { out[i] = decisions[j]; used.add(j); }
  });
  const idx = decisions.map((d) => d.index);
  const oneBased = !idx.includes(0) && idx.every((x) => x >= 1 && x <= corrections.length);
  decisions.forEach((d, k) => {
    if (used.has(k)) return;
    const i = oneBased ? d.index - 1 : d.index;
    if (i >= 0 && i < corrections.length && !out[i]) { out[i] = d; used.add(k); }
  });
  if (decisions.length === corrections.length) decisions.forEach((d, k) => { if (!used.has(k) && !out[k]) { out[k] = d; used.add(k); } });
  return out;
}
