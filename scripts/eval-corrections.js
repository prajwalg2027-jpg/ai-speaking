// Live evaluation of correction quality, strategy A (one call) vs B (one call + a check), against the real AI.
// Costs real money (about ₹2 for the full set; twice that with --repeat 2). Not part of `npm test`.
//
//   npm run eval                                  # the full set, the default intensity
//   npm run eval -- --intensity strict --concurrency 2 --only voice,tense --repeat 2 --out docs/eval/run.json
//   npm run eval -- --rescore docs/eval/run.json  # score saved results again (no AI calls), e.g. after a scorer fix
//
// With DATABASE_URL set, a new run is also saved in eval_runs (and shows in the admin console).
// Keep concurrency at 2 or so: Sarvam rate-limits bursts (429), and failed turns are not scored.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as settings from '../server/settings.js';
import { structured } from '../server/llm/index.js';
import { loadDataset, runEval, rescore } from '../server/learning/eval.js';
import { saveRun } from '../server/learning/evalRuns.js';
import { PROMPT_VERSION } from '../server/learning/prompts.js';
import { pool } from '../server/db/pool.js';

const { values: a } = parseArgs({ options: {
  intensity: { type: 'string' }, concurrency: { type: 'string', default: '2' }, only: { type: 'string' },
  limit: { type: 'string' }, repeat: { type: 'string', default: '1' }, out: { type: 'string' }, rescore: { type: 'string' },
} });

function print(s) {
  const row = (k, f) => `  ${k.padEnd(28)} ${String(f(s.single)).padStart(12)} ${String(f(s.verify)).padStart(12)}`;
  console.log(`\n  ${''.padEnd(28)} ${'A: single'.padStart(12)} ${'B: verify'.padStart(12)}`);
  console.log(row('precision %', (x) => x.precision));
  console.log(row('false alarms on clean %', (x) => x.falseAlarmRate));
  console.log(row('recall %', (x) => x.recall));
  console.log(row('F0.5 %', (x) => x.f05));
  console.log(row('right / false / missed', (x) => `${x.tp}/${x.fp}/${x.fn}`));
  console.log(row('latency p50 / p95 ms', (x) => `${x.latencyMs.p50}/${x.latencyMs.p95}`));
  console.log(row('cost per turn ₹', (x) => x.costInr.perTurn));
  console.log(row('failed', (x) => x.failed));
}

const ds = await loadDataset();

if (a.rescore) {
  const saved = JSON.parse(await readFile(a.rescore, 'utf8'));
  const again = rescore(saved, ds.items);
  print(again.summary);
  await writeFile(a.rescore, JSON.stringify({ ...saved, ...again, rescoredAt: new Date().toISOString() }, null, 2));
  console.log(`\nRe-scored ${a.rescore}`);
  await pool?.end();
  process.exit(0);
}

await settings.load();
const cfg = { corrections: settings.get('corrections'), conversation: settings.get('conversation') };
let items = ds.items;
if (a.only) { const g = new Set(a.only.split(',')); items = items.filter((i) => g.has(i.group) || g.has(i.id)); }
if (a.limit) items = items.slice(0, Number(a.limit));
const repeat = Math.max(1, Number(a.repeat));
const all = Array.from({ length: repeat }, () => items).flat().map((i, k) => (repeat > 1 ? { ...i, id: `${i.id}#${Math.floor(k / items.length) + 1}` } : i));

const llm = settings.get('llm');
console.log(`Evaluating ${all.length} turns (${items.length} items × ${repeat}) · ${a.intensity || cfg.corrections.defaultIntensity} intensity · prompt ${PROMPT_VERSION} · tutor ${llm.tutor.provider}/${llm.tutor.model} · check ${llm.verify.provider}/${llm.verify.model}`);
const t0 = Date.now();
const run = await runEval({ structured, settings: cfg, items: all, intensity: a.intensity || undefined, concurrency: Number(a.concurrency),
  onProgress: (d, n) => process.stdout.write(`\r  ${d}/${n}`) });
console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
print(run.summary);

const config = { dataset: ds.version, intensity: run.summary.intensity, repeat, only: a.only || null, promptVersion: PROMPT_VERSION, llm, corrections: cfg.corrections };
if (a.out) { await mkdir(dirname(a.out), { recursive: true }); await writeFile(a.out, JSON.stringify({ config, ...run }, null, 2)); console.log(`\nSaved ${a.out}`); }
if (pool) { const id = await saveRun({ datasetVersion: ds.version, promptVersion: PROMPT_VERSION, config, run, startedBy: 'cli' }); console.log(`Saved run ${id} in the database`); await pool.end(); }
