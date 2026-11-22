// The pre-production download page (server/builds.js): only the right token gets in, nothing is indexed or cached,
// the page shows the latest build, and the APK streams from the bucket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { handleBuilds, setStorage } from '../server/builds.js';

const TOKEN = 'a3f9c2e17b5d48e0a6c1f2b3';
const APK = Buffer.alloc(300_000, 7);
let bucket, server, base;

before(async () => {
  Object.assign(process.env, { BUILDS_TOKEN: TOKEN, BUILDS_BUCKET: 'test-builds' });
  bucket = new Map();
  setStorage({
    download: async (b, p) => (b === 'test-builds' && bucket.has(p) ? Buffer.from(bucket.get(p)) : null),
    stream: async (b, p) => (b === 'test-builds' && bucket.has(p) ? { body: new Blob([bucket.get(p)]).stream(), size: bucket.get(p).length } : null),
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await handleBuilds(req, res, url))) { res.writeHead(418); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const get = (path, opts) => fetch(`${base}${path}`, { redirect: 'manual', ...opts });

test('a wrong or missing token is a plain 404, never indexed', async () => {
  for (const p of ['/internal', '/internal/', '/internal/wrong-token-wrong-token/', `/internal/${TOKEN}x/`, `/internal/${TOKEN}/other.apk`]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.headers.get('x-robots-tag'), /noindex/);
  }
  assert.equal((await get(`/internal/${TOKEN}/`, { method: 'POST' })).status, 404);
  assert.equal((await get('/somewhere-else')).status, 418, 'other paths are not touched');
});

test('before any build: the page says so', async () => {
  const r = await get(`/internal/${TOKEN}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /No build has been published yet/);
  assert.equal((await get(`/internal/${TOKEN}/adam.apk`)).status, 404);
});

test('the page shows the latest build, hidden from search engines and caches', async () => {
  bucket.set('latest/adam-test.apk', APK);
  bucket.set('latest/build.json', Buffer.from(JSON.stringify({ versionCode: 412, versionName: '0.1.0', commit: 'cf42f0e1234', branch: 'tutor-conversation', message: 'App: paywall <b>after</b> the score\n\nbody', builtAt: '2026-11-21T09:00:00Z', sizeBytes: APK.length })));
  assert.equal((await get(`/internal/${TOKEN}`)).status, 200, 'without the slash too (the website strips it)');
  const r = await get(`/internal/${TOKEN}/`);
  const html = await r.text();
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.match(html, /Build 412 \(0\.1\.0\)/);
  assert.match(html, /21 Nov 2026, 2:30 pm IST/);
  assert.match(html, /&lt;b&gt;after&lt;\/b&gt;/, 'the commit message is escaped');
  assert.match(html, new RegExp(`href="/internal/${TOKEN}/adam\\.apk"`));
  // Through adamspeaks.in, Host is Cloud Run's: the download goes straight to Cloud Run.
  const viaHosting = await new Promise((ok, no) => request(`${base}/internal/${TOKEN}/`, { headers: { host: 'adam-abc123-el.a.run.app' } }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok(t));
  }).on('error', no).end());
  assert.match(viaHosting, new RegExp(`href="https://adam-abc123-el\\.a\\.run\\.app/internal/${TOKEN}/adam\\.apk"`));
});

test('the APK streams from the bucket as a download', async () => {
  const r = await get(`/internal/${TOKEN}/adam.apk`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="adam-test\.apk"/);
  assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), APK), 0);
});

test('switched off without a token or bucket', async () => {
  delete process.env.BUILDS_TOKEN;
  try { assert.equal((await get(`/internal/${TOKEN}/`)).status, 404); } finally { process.env.BUILDS_TOKEN = TOKEN; }
});
