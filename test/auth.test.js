import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMockRealtime } from './mock-sarvam-realtime.js';

let mock, server, base;

before(async () => {
  mock = await startMockRealtime();
  process.env.APP_PASSWORD = 'open sesame';
  process.env.SARVAM_API_KEY = 'test-key';
  process.env.SARVAM_REALTIME_URL = mock.url;
  delete process.env.HTTPS_PROXY;
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await mock.close(); });

const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const login = (password, ip = '10.0.0.1') => fetch(`${base}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
  body: new URLSearchParams({ password }),
});
const wsOpen = (cookie) => new Promise((resolve) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/live`, { headers: cookie ? { cookie } : {} });
  ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
  ws.on('message', (m) => { if (JSON.parse(m).type === 'ready') { ws.close(); resolve('ready'); } });
  ws.on('error', () => {});
});

test('signed-out visitors are sent to the login page; health check stays public', async () => {
  const home = await get('/');
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/login');
  assert.equal((await get('/app.js')).status, 303);
  assert.equal((await get('/api/config')).status, 401);
  assert.equal((await fetch(`${base}/api/turn?q=0`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
  const page = await get('/login');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /type="password"/);
  assert.equal(await (await get('/healthz')).text(), 'ok');
});

test('wrong password is refused; right password sets an HttpOnly cookie that unlocks everything', async () => {
  const bad = await login('nope', '10.0.0.2');
  assert.equal(bad.headers.get('location'), '/login?e');
  assert.equal(bad.headers.get('set-cookie'), null);

  const good = await login('open sesame', '10.0.0.3');
  assert.equal(good.headers.get('location'), '/');
  const setCookie = good.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(';')[0];
  assert.ok(!cookie.includes('open sesame'), 'cookie must not contain the password');

  assert.equal((await get('/', cookie)).status, 200);
  assert.deepEqual(await (await get('/api/config', cookie)).json(), { demo: false, realtime: true });
  assert.equal((await get('/api/config', 'sakhi_auth=' + 'a'.repeat(64))).status, 401, 'forged cookie rejected');
});

test('live-speech WebSocket requires the cookie', async () => {
  assert.equal(await wsOpen(), 401);
  const cookie = (await login('open sesame', '10.0.0.4')).headers.get('set-cookie').split(';')[0];
  assert.equal(await wsOpen(cookie), 'ready');
});

test('repeated wrong passwords from one address are slowed down', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await login('guess' + i, '10.0.0.9');
  assert.equal(last.headers.get('location'), '/login?slow');
  // Even the right password is refused while throttled.
  assert.equal((await login('open sesame', '10.0.0.9')).headers.get('location'), '/login?slow');
});
