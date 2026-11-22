// Correction-quality evaluation: runs the dataset (shared/eval/corrections-v1.json) through the real tutor turn and
// scores both strategies side by side from the SAME first call, so the only difference is strategy B's check.
// Precision first: a false correction (correcting valid English, or a wrong fix) is the costliest error.
//
// Used by `npm run eval` (scripts/eval-corrections.js) and the admin console (saved in eval_runs).
import { readFile } from 'node:fs/promises';
import { norm } from './corrections.js';
import { tutorTurn } from './tutor.js';

export const DATASET = new URL('../../shared/eval/corrections-v1.json', import.meta.url);
export const loadDataset = async () => JSON.parse(await readFile(DATASET, 'utf8'));

const toks = (s) => norm(s).split(/[\s.,!?;:"]+/).filter(Boolean);
/** Does word sequence `needle` appear inside `hay`? */
function containsWords(hay, needle) {
  const h = toks(hay), n = toks(needle);
  if (!n.length || n.length > h.length) return false;
  for (let i = 0; i + n.length <= h.length; i++) if (n.every((w, j) => h[i + j] === w)) return true;
  return false;
}
const overlaps = (a, b) => containsWords(a, b) || containsWords(b, a);

/**
 * Score one item's shown corrections against what was expected.
 * → { tp, fp, fn, wrongFix, falseCorrections: [..], missed: [..] }
 */
export function scoreItem(item, corrections) {
  const expect = item.expect || [], allow = item.allow || [];
  const matched = new Set();
  let tp = 0, fp = 0, wrongFix = 0;
  const falseCorrections = [];
  for (const c of corrections) {
    const i = expect.findIndex((e, k) => !matched.has(k) && overlaps(c.original, e.span));
    if (i >= 0) {
      const e = expect[i];
      // The fix counts if the corrected words contain it, or the expected words with the correction applied do
      // ("amount" → "number" turns "amount of people" into "number of people").
      const applied = containsWords(e.span, c.original) ? ` ${toks(e.span).join(' ')} `.replace(` ${toks(c.original).join(' ')} `, ` ${toks(c.corrected).join(' ')} `) : '';
      const fixed = (e.fix || []).length === 0 || e.fix.some((f) => containsWords(c.corrected, f) || containsWords(applied, f));
      matched.add(i);
      if (fixed) tp++; else { fp++; wrongFix++; falseCorrections.push({ ...pick(c), why: `wrong fix (expected ${e.fix.join(' / ')})` }); }
      continue;
    }
    if (expect.some((e) => overlaps(c.original, e.span))) continue;       // a second correction of the same mistake
    if (allow.some((a) => overlaps(c.original, a))) continue;              // ambiguous: no penalty either way
    fp++; falseCorrections.push({ ...pick(c), why: 'not a mistake' });
  }
  const missed = expect.filter((_, k) => !matched.has(k)).map((e) => e.span);
  // A wrongly fixed mistake is also a missed one.
  return { tp, fp, fn: missed.length + wrongFix, wrongFix, falseCorrections, missed };
}
const pick = (c) => ({ original: c.original, corrected: c.corrected, category: c.category, severity: c.severity });

const pct = (x) => (x == null ? null : +(x * 100).toFixed(1));
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Totals for one strategy over scored items. */
export function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  const t = ok.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn, wrongFix: a.wrongFix + r.wrongFix }), { tp: 0, fp: 0, fn: 0, wrongFix: 0 });
  const precision = t.tp + t.fp ? t.tp / (t.tp + t.fp) : null;
  const recall = t.tp + t.fn ? t.tp / (t.tp + t.fn) : null;
  const b2 = 0.25; // F0.5: precision weighs twice as much as recall
  const f05 = precision != null && recall != null && precision + recall > 0 ? ((1 + b2) * precision * recall) / (b2 * precision + recall) : null;
  const clean = ok.filter((r) => !r.expectCount);
  const ms = ok.map((r) => r.ms);
  return {
    items: rows.length, failed: rows.length - ok.length, ...t,
    precision: pct(precision), recall: pct(recall), f05: pct(f05),
    // Of the messages with nothing to correct, how many got a correction anyway.
    falseAlarmRate: pct(clean.length ? clean.filter((r) => r.fp > 0).length / clean.length : null), cleanItems: clean.length,
    latencyMs: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), mean: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null },
    costInr: { total: +ok.reduce((a, r) => a + r.costInr, 0).toFixed(3), perTurn: ok.length ? +(ok.reduce((a, r) => a + r.costInr, 0) / ok.length).toFixed(4) : null },
    checks: ok.filter((r) => r.checked).length,
  };
}

function byGroup(results, key) {
  const groups = {};
  for (const r of results) (groups[r.group] ||= []).push(r[key]);
  return Object.fromEntries(Object.entries(groups).map(([g, rows]) => {
    const s = summarize(rows);
    return [g, { items: s.items, tp: s.tp, fp: s.fp, fn: s.fn, precision: s.precision, recall: s.recall }];
  }));
}

/** Score saved results again with the current scorer (no AI calls), e.g. after fixing the scorer or the labels. */
export function rescore(run, items, intensity = run.summary?.intensity) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const results = run.results.map((r) => {
    const item = byId.get(r.id.replace(/#\d+$/, ''));
    if (!item || r.error) return r;
    const again = (side) => ({ ...side, ...scoreItem(item, side.corrections), expectCount: (item.expect || []).length });
    return { ...r, expectCount: (item.expect || []).length, single: again(r.single), verify: again(r.verify) };
  });
  return {
    summary: { intensity, single: summarize(results.map((r) => r.single)), verify: summarize(results.map((r) => r.verify)), byGroup: { single: byGroup(results, 'single'), verify: byGroup(results, 'verify') } },
    results,
  };
}

/**
 * Run the evaluation. → { summary: { single, verify, byGroup }, results }
 * @param {object} p
 * @param {Function} p.structured   the AI provider layer
 * @param {object}   p.settings     { corrections, conversation }
 * @param {Array}    p.items
 * @param {string}   [p.intensity]  defaults to the admin's default
 * @param {number}   [p.concurrency]
 * @param {Function} [p.onProgress] (done, total)
 */
export async function runEval({ structured, settings, items, intensity = settings.corrections.defaultIntensity, concurrency = 3, onProgress }) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++, item = items[i];
      const base = { id: item.id, group: item.group, channel: item.channel || 'text', text: item.text, expectCount: (item.expect || []).length };
      try {
        const t = await tutorTurn({ structured, settings, compare: true, strategy: 'single', message: item.text, channel: item.channel || 'text', intensity, profile: { level: item.level }, history: [] });
        const one = (side, extra) => ({ ...scoreItem(item, side.corrections), corrections: side.corrections.map(pick), ms: side.ms, costInr: side.costInr, expectCount: base.expectCount, ...extra });
        results[i] = {
          ...base, reply: t.reply, proposed: t.proposed.map(pick),
          single: one(t.compare.single, {}),
          verify: one(t.compare.verify, { checked: t.compare.verify.checkMs != null, checkError: t.compare.verify.checkError,
            droppedByCheck: t.compare.verify.dropped.filter((d) => d.reason.startsWith('check')).map((d) => ({ ...pick(d.correction), reason: d.reason })) }),
        };
      } catch (e) {
        const err = { error: e.message, expectCount: base.expectCount, tp: 0, fp: 0, fn: 0, wrongFix: 0, ms: 0, costInr: 0 };
        results[i] = { ...base, error: e.message, single: err, verify: err };
      }
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return {
    summary: {
      intensity,
      single: summarize(results.map((r) => r.single)),
      verify: summarize(results.map((r) => r.verify)),
      byGroup: { single: byGroup(results, 'single'), verify: byGroup(results, 'verify') },
    },
    results,
  };
}
