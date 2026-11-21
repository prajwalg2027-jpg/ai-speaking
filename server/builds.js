// PRE-PRODUCTION ONLY. REMOVE BEFORE THE PUBLIC LAUNCH (docs/HANDOFF.md › Before production).
//
// The latest Android test build, for the team: https://adamspeaks.in/internal/<BUILDS_TOKEN> (the website sends
// /internal/** here; deploy/builds-setup.sh). CI uploads every build of tutor-conversation and main to the private
// bucket BUILDS_BUCKET (latest/adam-test.apk + latest/build.json); this page shows it and streams the APK.
//
// Not listed anywhere and not indexed (X-Robots-Tag, meta robots); the random token in the path is what keeps
// it private, so share the link only with testers. Without BUILDS_TOKEN and BUILDS_BUCKET, /internal/ is a 404.
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { gcsDownload, gcsStream } from './gcp.js';

let storage = { download: gcsDownload, stream: gcsStream };
/** For tests: a fake bucket. */
export function setStorage(s) { storage = s; }

const APK = 'latest/adam-test.apk', INFO = 'latest/build.json';
const HIDDEN = { 'x-robots-tag': 'noindex, nofollow, noarchive', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };

function tokenOk(given) {
  const want = process.env.BUILDS_TOKEN || '';
  if (want.length < 16 || !process.env.BUILDS_BUCKET) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ist = (iso) => { try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'; } catch { return ''; } };

function page(info, apkUrl) {
  const b = info || {};
  const mb = b.sizeBytes ? ` · ${(b.sizeBytes / 1048576).toFixed(1)} MB` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>Adam test build</title>
<style>
:root{--bg:#FBF6F1;--card:#fff;--ink:#2B211C;--ink2:#6E6159;--accent:#B44D34;--line:#EADFD6}
@media (prefers-color-scheme:dark){:root{--bg:#1C1714;--card:#262019;--ink:#F3ECE6;--ink2:#B9ABA0;--accent:#E07A5F;--line:#3A312A}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px}
h1{font-size:26px;margin:0 0 4px}.tag{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
.meta{color:var(--ink2);font-size:14px;margin:0 0 20px}
.btn{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;padding:16px;border-radius:14px}
ol{padding-left:20px;color:var(--ink2);font-size:15px}code{font-size:13px}
.note{font-size:13px;color:var(--ink2);margin-top:20px}
</style></head><body><main><div class="card">
<span class="tag">Pre-production · test build</span>
<h1>Adam for Android</h1>
${info ? `<p class="meta">Build ${esc(b.versionCode)} (${esc(b.versionName)}) · ${esc(ist(b.builtAt))}${mb}<br>
${esc(b.branch)} · <code>${esc(String(b.commit || '').slice(0, 7))}</code> ${esc(String(b.message || '').split('\n')[0].slice(0, 90))}</p>
<a class="btn" href="${esc(apkUrl)}">Download the latest build</a>` : '<p class="meta">No build has been published yet. It appears here after the next push.</p>'}
<ol>
<li>Open the downloaded file on your Android phone.</li>
<li>If asked, allow your browser to install unknown apps, then tap Install.</li>
<li>Updating: install the new build over the old one; your sign-in stays.</li>
</ol>
<p class="note">Every push updates this page automatically. Please don't share this link outside the team.</p>
</div></main></body></html>`;
}

/** /internal/<token>/ and /internal/<token>/adam.apk. → true when handled */
export async function handleBuilds(req, res, url) {
  if (!url.pathname.startsWith('/internal')) return false;
  const m = /^\/internal\/([^/]+)(\/|\/adam\.apk)?$/.exec(url.pathname);
  if (!m || !['GET', 'HEAD'].includes(req.method) || !tokenOk(m[1])) {
    res.writeHead(404, { 'content-type': 'text/plain', ...HIDDEN }); res.end('Not found'); return true;
  }
  const bucket = process.env.BUILDS_BUCKET;
  if (m[2] !== '/adam.apk') {
    // With or without the slash: the website strips trailing slashes, so a redirect here would loop.
    const raw = await storage.download(bucket, INFO);
    let info = null; try { info = raw && JSON.parse(raw.toString('utf8')); } catch { /* shown as no build */ }
    // Straight from Cloud Run (when the page came through adamspeaks.in, Host is still Cloud Run's): no size limits.
    const host = req.headers.host;
    const apkUrl = `${host && /\.run\.app$/.test(host) ? `https://${host}` : ''}/internal/${m[1]}/adam.apk`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...HIDDEN });
    res.end(page(info, apkUrl));
    return true;
  }
  const r = await storage.stream(bucket, APK);
  if (!r) { res.writeHead(404, { 'content-type': 'text/plain', ...HIDDEN }); res.end('No build yet'); return true; }
  res.writeHead(200, {
    'content-type': 'application/vnd.android.package-archive',
    'content-disposition': 'attachment; filename="adam-test.apk"',
    ...(r.size ? { 'content-length': String(r.size) } : {}), ...HIDDEN,
  });
  if (req.method === 'HEAD') { r.body.cancel?.(); res.end(); return true; }
  Readable.fromWeb(r.body).pipe(res);
  return true;
}
