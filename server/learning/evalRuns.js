// Evaluation runs, saved in eval_runs so the admin console can show and compare them. A run started from the
// console runs in the background on the server; its row shows "running" until it finishes.
import { pool } from '../db/pool.js';
import * as settings from '../settings.js';
import { structured as defaultStructured } from '../llm/index.js';
import { loadDataset, runEval } from './eval.js';
import { PROMPT_VERSION } from './prompts.js';

export async function saveRun({ datasetVersion, promptVersion, config, run, startedBy }) {
  const { rows: [r] } = await pool.query(`insert into eval_runs (status, dataset_version, prompt_version, config, summary, results, started_by, finished_at)
      values ('done', $1, $2, $3, $4, $5, $6, now()) returning id`, [datasetVersion, promptVersion, config, run.summary, JSON.stringify(run.results), startedBy]);
  return r.id;
}

export async function list(limit = 20) {
  return (await pool.query(`select id, status, dataset_version, prompt_version, config, summary, started_by, started_at, finished_at
      from eval_runs order by started_at desc limit $1`, [limit])).rows;
}

export const get = async (id) => (await pool.query('select * from eval_runs where id = $1', [id])).rows[0] || null;

let running = null;
const progress = new Map();
export const progressOf = (id) => progress.get(id) || null;

/** Start a run in the background (one at a time per server). → its id */
export async function start({ intensity, only, startedBy, structured = defaultStructured, concurrency = 3 }) {
  if (running) throw Object.assign(new Error('an evaluation is already running'), { status: 409 });
  const ds = await loadDataset();
  let items = ds.items;
  if (only?.length) { const g = new Set(only); items = items.filter((i) => g.has(i.group)); }
  if (!items.length) throw Object.assign(new Error('no items match'), { status: 400 });
  const cfg = { corrections: settings.get('corrections'), conversation: settings.get('conversation') };
  const config = { dataset: ds.version, intensity: intensity || cfg.corrections.defaultIntensity, only: only || null, llm: settings.get('llm'), corrections: cfg.corrections };
  const { rows: [r] } = await pool.query(`insert into eval_runs (dataset_version, prompt_version, config, started_by) values ($1, $2, $3, $4) returning id`,
    [ds.version, PROMPT_VERSION, config, startedBy || null]);
  progress.set(r.id, { done: 0, total: items.length });
  running = runEval({ structured, settings: cfg, items, intensity: config.intensity, concurrency, onProgress: (done, total) => progress.set(r.id, { done, total }) })
    .then((run) => pool.query(`update eval_runs set status = 'done', summary = $2, results = $3, finished_at = now() where id = $1`, [r.id, run.summary, JSON.stringify(run.results)]))
    .catch((e) => { console.error('[eval] run failed:', e.message); return pool.query(`update eval_runs set status = 'failed', summary = $2, finished_at = now() where id = $1`, [r.id, { error: e.message }]); })
    .finally(() => { running = null; progress.delete(r.id); });
  return r.id;
}

/** Runs left "running" by a server that stopped are marked failed at start. */
export const cleanUp = () => pool?.query(`update eval_runs set status = 'failed', summary = '{"error":"the server restarted during the run"}' where status = 'running'`);
