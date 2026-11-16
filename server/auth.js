// Optional password gate for public deployments. Enabled when APP_PASSWORD is set; off for local dev.
//
// After a correct password the browser gets an HttpOnly cookie (an HMAC of the password, so changing
// APP_PASSWORD logs everyone out). Every page, API call and the /api/live WebSocket upgrade checks it.
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'sakhi_auth';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function createGate(password) {
  if (!password) return { enabled: false, check: () => true, handle: () => false };
  const token = createHmac('sha256', password).update('sakhi-v1').digest('hex');
  const attempts = new Map(); // ip -> [timestamps], simple brute-force brake

  const cookieOk = (req) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
    return !!m && timingSafeEqual(Buffer.from(m[1]), Buffer.from(token));
  };
  const passwordOk = (given) => {
    const a = createHmac('sha256', password).update('cmp').digest();
    const b = createHmac('sha256', String(given ?? '')).update('cmp').digest();
    return timingSafeEqual(a, b);
  };
  const tooMany = (ip) => {
    const now = Date.now();
    const recent = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    recent.push(now);
    attempts.set(ip, recent);
    return recent.length > 10;
  };

  /** Handle login routes / block unauthenticated requests. Returns true if the response was sent. */
  async function handle(req, res, url) {
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return true; }
    if (url.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(loginPage(url.searchParams.has('e'), url.searchParams.has('slow')));
      return true;
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      let body = '';
      for await (const c of req) { body += c; if (body.length > 4096) break; }
      if (tooMany(ip)) { res.writeHead(303, { location: '/login?slow' }); res.end(); return true; }
      if (!passwordOk(new URLSearchParams(body).get('password'))) { res.writeHead(303, { location: '/login?e' }); res.end(); return true; }
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}` });
      res.end();
      return true;
    }
    if (cookieOk(req)) return false;
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'login required' }));
    } else {
      res.writeHead(303, { location: '/login' });
      res.end();
    }
    return true;
  }

  return { enabled: true, check: cookieOk, handle };
}

function loginPage(wrong, slow) {
  const msg = slow ? 'Too many attempts. Try again in a few minutes.' : wrong ? 'That password didn’t work. Try again.' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sakhi · English Coach</title>
<style>
  :root { --bg:#f7f7f5; --fg:#111; --muted:#6b6b6b; --card:#fff; --line:#e6e6e3; --accent:#3f8cff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0e; --fg:#f2f2f2; --muted:#9a9a9a; --card:#18181a; --line:#2a2a2d; } }
  * { box-sizing:border-box } html,body { margin:0; height:100%; background:var(--bg); color:var(--fg);
    font:16px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }
  main { min-height:100dvh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:22px; padding:16px }
  .orb { width:120px; height:120px; border-radius:50%;
    background:radial-gradient(circle at 35% 30%,#fff 0%,#bfe0ff 28%,#5aa8ff 62%,#1f5fe0 100%);
    box-shadow:0 0 60px rgba(90,168,255,.35) }
  h1 { margin:0; font-size:22px; font-weight:600 } p { margin:0; color:var(--muted); text-align:center; max-width:30ch }
  form { display:flex; flex-direction:column; gap:10px; width:100%; max-width:300px }
  input { font:inherit; padding:12px 14px; border-radius:12px; border:1px solid var(--line); background:var(--card); color:var(--fg) }
  input:focus { outline:2px solid var(--accent); outline-offset:1px }
  button { font:inherit; padding:12px; border:0; border-radius:12px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer }
  .err { color:#d93b3b; font-size:14px; min-height:1.2em }
</style></head><body><main>
  <div class="orb" aria-hidden="true"></div>
  <h1>Sakhi</h1>
  <p>Your voice English coach. Enter the password you were given.</p>
  <form method="post" action="/login">
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus aria-label="Password">
    <button type="submit">Start</button>
    <div class="err" role="alert">${msg}</div>
  </form>
</main></body></html>`;
}
