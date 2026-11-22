// Small HTTP helpers shared by the API handlers.
import { randomUUID } from 'node:crypto';

export async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('Payload too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 64 * 1024) {
  const text = (await readBody(req, limit)).toString();
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('the body is not valid JSON'), { status: 400 }); }
}

export const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };

export const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** A request id (the client's x-request-id, or a new one), echoed in the response and the logs. */
export function requestId(req, res) {
  const id = /^[\w-]{8,64}$/.test(req.headers['x-request-id'] || '') ? req.headers['x-request-id'] : randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

/** One structured log line per request (Cloud Logging reads JSON lines). */
export function logRequest({ rid, req, status, ms, user, extra }) {
  console.log(JSON.stringify({ severity: status >= 500 ? 'ERROR' : status >= 400 ? 'WARNING' : 'INFO', rid, method: req.method, path: new URL(req.url, 'http://x').pathname, status, ms, user: user || undefined, ...extra }));
}

/** Match "/api/learn/conversations/:id/messages" style patterns. → params or null */
export function route(pattern, pathname) {
  const p = pattern.split('/'), a = pathname.split('/');
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) { if (!a[i]) return null; params[p[i].slice(1)] = decodeURIComponent(a[i]); } else if (p[i] !== a[i]) return null;
  }
  return params;
}

export const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
