// Diagnostics: detailed logs from the team's own phones, so a problem seen while using the app can be read
// afterwards, step by step (docs/DIAGNOSTICS.md).
//
// The app keeps a log of what it does (conversation turns, mic, voice, barge-in, the live speech connection,
// every request with its timing, errors) and, on a phone signed in with a team number, sends it here in batches.
// Requests from that phone carry its diagnostics code (header x-adam-diag): the server adds its own lines for them
// (each request's status and time, each turn's trace), so one timeline holds both sides.
//
//   GET  /api/diag/status          (signed in)  → { enabled }  only team numbers (ADMIN_PHONES, the admin team,
//                                                 DIAG_PHONES) send logs
//   POST /api/diag/logs            (signed in, enabled)  { diagId, device, events: [{ t, seq, cat, name, sid?, data? }] }
//   GET  /api/diag/logs/:diagId    ?since=30m|2h|1d|ISO  &session=<sessionId>  &limit=2000  &format=text|json
//                                  No login: the 32-character code is the key. Kept 14 days.
//
// Never logged: one-time codes, login tokens, raw audio. Transcripts of what was said are (that's the point).
import { pool } from './db/pool.js';
import { identify } from './accounts.js';
import { loginEnabled } from './auth.js';
import { serverOwners, neverAdmin } from './admin/team.js';
import { readJson, send, fail } from './http.js';

const ID = /^[a-f0-9]{32}$/;
const KEEP_DAYS = 14;
const MAX_EVENTS = 500;
/** Keys whose values are never stored, whatever sends them. */
const SECRET = /^(otp|code|token|idtoken|accesstoken|refreshtoken|password|authorization|cookie|secret|apikey|key|phone|verificationid)$/i;

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** May this signed-in person send diagnostics? Team numbers only (and anyone on a local server without login). */
export async function allowed(user) {
  if (!loginEnabled()) return true;
  const phone = user?.phone;
  if (!phone || neverAdmin().has(phone)) return false;
  if (serverOwners().has(phone) || list(process.env.DIAG_PHONES).includes(phone)) return true;
  if (!pool) return false;
  const r = await pool.query('select 1 from admin_members where phone = $1 and active', [phone]);
  return r.rowCount > 0;
}

/** Strings cut short, secrets dropped, nesting kept shallow. */
export function clean(v, depth = 0) {
  if (v == null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.length > 1000 ? `${v.slice(0, 1000)}…` : v;
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => clean(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 60)) if (!SECRET.test(k)) o[k.slice(0, 60)] = clean(x, depth + 1);
    return o;
  }
  return String(v).slice(0, 200);
}

function cleanEvent(e) {
  if (!e || typeof e !== 'object' || typeof e.name !== 'string') return null;
  const t = typeof e.t === 'string' && !Number.isNaN(Date.parse(e.t)) ? new Date(e.t).toISOString() : new Date().toISOString();
  return {
    t, seq: Number.isInteger(e.seq) ? e.seq : 0, cat: String(e.cat || 'app').slice(0, 30), name: e.name.slice(0, 80),
    ...(typeof e.sid === 'string' && e.sid ? { sid: e.sid.slice(0, 80) } : {}),
    ...(e.up != null && Number.isFinite(e.up) ? { up: e.up } : {}),
    ...(e.data && typeof e.data === 'object' ? { data: clean(e.data) } : {}),
  };
}

async function save({ diagId, userId, source, device, events }) {
  await pool.query('insert into diag_batches (diag_id, user_id, source, device, events) values ($1, $2, $3, $4, $5)',
    [diagId, userId || null, source, device ? JSON.stringify(clean(device)) : null, JSON.stringify(events)]);
  if (Math.random() < 0.02) pool.query(`delete from diag_batches where received_at < now() - interval '${KEEP_DAYS} days'`).catch(() => {});
}

// Codes a team phone has sent logs under (so the server's own lines are kept only for those).
const known = new Map(); // diagId → { ok, at }
async function isKnown(diagId) {
  const k = known.get(diagId);
  if (k && Date.now() - k.at < (k.ok ? 3_600_000 : 60_000)) return k.ok;
  const ok = (await pool.query(`select 1 from diag_batches where diag_id = $1 and source = 'app' limit 1`, [diagId])).rowCount > 0;
  if (known.size > 1000) known.clear();
  known.set(diagId, { ok, at: Date.now() });
  return ok;
}

/** The diagnostics code a request carries, if any. */
export const codeOf = (req) => { const c = req.headers['x-adam-diag']; return typeof c === 'string' && ID.test(c) ? c : null; };

/**
 * The server's own lines for a request from a phone sending diagnostics: [{ name, data, sid? }].
 * Best effort and never in the request's way.
 */
export function record(req, lines) {
  const diagId = codeOf(req);
  if (!diagId || !pool) return;
  const rid = req.headers['x-request-id'];
  const now = new Date().toISOString();
  const events = lines.map((l, i) => cleanEvent({ t: now, seq: i, cat: 'server', name: l.name, sid: l.sid, data: { ...(rid ? { rid } : {}), ...l.data } })).filter(Boolean);
  isKnown(diagId).then((ok) => ok && save({ diagId, source: 'server', events })).catch((e) => console.warn('[diag] not saved:', e.message));
}

/** "30m", "2h", "1d" or an ISO time → Date */
export function parseSince(s) {
  if (!s) return null;
  const m = /^(\d+)\s*([smhd])$/.exec(s);
  if (m) return new Date(Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function read(diagId, { since, session, limit = 2000 } = {}) {
  const from = since || new Date(Date.now() - 864e5); // the last day, unless asked
  const rows = (await pool.query(`select source, device, events, received_at from diag_batches
      where diag_id = $1 and received_at >= $2::timestamptz - interval '10 minutes' order by received_at, id`, [diagId, from])).rows;
  let device = null;
  const all = [];
  for (const r of rows) {
    if (r.device) device = r.device;
    for (const e of r.events) if (Date.parse(e.t) >= from.getTime()) all.push({ ...e, src: r.source });
  }
  let events = session ? all.filter((e) => e.sid === session) : all;
  events.sort((a, b) => a.t.localeCompare(b.t) || (a.src === b.src ? a.seq - b.seq : 0));
  const total = events.length;
  if (events.length > limit) events = events.slice(-limit); // the latest
  const sessions = [...new Set(all.map((e) => e.sid).filter(Boolean))];
  return { diagId, device, from: from.toISOString(), total, shown: events.length, sessions, events };
}

const fmtVal = (v) => (typeof v === 'string' ? (/[\s"=]/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v));

/** One line an event, easy to read and to grep: time, +ms since the line before, [cat] name, key=value… */
export function asText(r) {
  const out = [`# Adam diagnostics ${r.diagId} · from ${r.from} · ${r.shown} of ${r.total} events`,
    `# device: ${r.device ? JSON.stringify(r.device) : 'unknown'}`,
    `# sessions: ${r.sessions.join(', ') || 'none'}`];
  let prev = null;
  for (const e of r.events) {
    const at = Date.parse(e.t);
    const gap = prev == null ? '' : `+${at - prev}ms`;
    prev = at;
    const data = e.data ? Object.entries(e.data).map(([k, v]) => `${k}=${fmtVal(v)}`).join(' ') : '';
    out.push(`${e.t.slice(11, 23)} ${gap.padStart(8)} ${e.src === 'server' ? 'S' : 'A'} [${e.cat}] ${e.name}${e.sid ? ` sid=${e.sid.slice(0, 8)}` : ''}${data ? ` ${data}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

/** /api/diag/** → true when handled */
export async function handleDiag(req, res, url) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/diag/')) return false;
  if (!pool) throw fail(503, 'diagnostics need the database (DATABASE_URL)');

  if (m === 'GET' && p === '/api/diag/status') {
    const { user } = await identify(req, { required: true });
    return send(res, 200, { enabled: await allowed(user), keepDays: KEEP_DAYS }), true;
  }
  if (m === 'POST' && p === '/api/diag/logs') {
    const { user } = await identify(req, { required: true });
    if (!(await allowed(user))) throw fail(403, 'diagnostics are for the team’s phones');
    const b = await readJson(req, 1024 * 1024);
    if (!ID.test(b.diagId || '')) throw fail(400, 'diagId: 32 lowercase hex characters');
    if (!Array.isArray(b.events) || b.events.length > MAX_EVENTS) throw fail(400, `events: a list of up to ${MAX_EVENTS}`);
    const events = b.events.map(cleanEvent).filter(Boolean);
    if (events.length) await save({ diagId: b.diagId, userId: user?.id, source: 'app', device: b.device, events });
    known.set(b.diagId, { ok: true, at: Date.now() });
    return send(res, 200, { saved: events.length }), true;
  }
  const id = m === 'GET' && /^\/api\/diag\/logs\/([^/]+)$/.exec(p)?.[1];
  if (id) {
    if (!ID.test(id)) throw fail(404, 'not found');
    const q = url.searchParams;
    const since = q.has('since') ? parseSince(q.get('since')) : null;
    if (q.has('since') && !since) throw fail(400, 'since: like 30m, 2h, 1d, or an ISO time');
    const limit = Math.min(Math.max(Number(q.get('limit')) || 2000, 1), 20000);
    const r = await read(id, { since, session: q.get('session') || null, limit });
    res.setHeader('cache-control', 'no-store');
    if (q.get('format') === 'json') return send(res, 200, r), true;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(asText(r));
    return true;
  }
  throw fail(404, 'not found');
}
