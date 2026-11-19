// Builds website/src -> website/dist, filling {{TOKENS}} from site.config.json.
// Refuses to build if any value is blank, so the privacy policy never ships with gaps.
//   node build.mjs            production build (used by `firebase deploy` predeploy)
//   node build.mjs --preview  fills blanks with visible [placeholders] for a local look
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'src');
const out = join(here, 'dist');
const preview = process.argv.includes('--preview');

const cfg = JSON.parse(readFileSync(join(here, 'site.config.json'), 'utf8'));
cfg.YEAR = String(new Date().getFullYear());
cfg.SITE_URL = (cfg.SITE_URL || '').replace(/\/+$/, '');

const blank = Object.entries(cfg).filter(([, v]) => !String(v ?? '').trim()).map(([k]) => k);
if (blank.length && !preview) {
  console.error(`website/site.config.json is missing: ${blank.join(', ')}\nFill these in, then deploy again.`);
  process.exit(1);
}
for (const k of blank) cfg[k] = `[${k}]`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TEXT = new Set(['.html', '.xml', '.txt']);

rmSync(out, { recursive: true, force: true });
let count = 0;
const build = (from, to) => {
  if (statSync(from).isDirectory()) { mkdirSync(to, { recursive: true }); for (const n of readdirSync(from)) build(join(from, n), join(to, n)); return; }
  count++;
  if (!TEXT.has(extname(from))) return copyFileSync(from, to);
  writeFileSync(to, readFileSync(from, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in cfg)) throw new Error(`${from}: unknown token ${m}`);
    return esc(cfg[k]);
  }));
};
build(src, out);
console.log(`Built ${count} files into website/dist${preview ? ' (preview)' : ''}`);
