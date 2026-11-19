// Production guard: what a public server must refuse. Off in development (npm start on your Mac), on when
// NODE_ENV=production (the Cloud Run deployment).
//
// - Team tools (question review, cut-off editor, STT lab, mic test, per-conversation cost, the scoring
//   trace in replies) are for the team and stay off unless SAKHI_TEAM_TOOLS=1.
// - Anyone who finds the address could spend the Sarvam credit, so: conversations per device address per
//   hour, turns per conversation, listening time per conversation, and a daily spending cap.
// - Sakhi's voice only says lines she actually said in that conversation, or the fixed lines (so the
//   voice endpoint can't be used as free text-to-speech).
const num = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== '' ? Number(process.env[k]) : d);

export const production = process.env.NODE_ENV === 'production';
export const teamTools = !production || process.env.SAKHI_TEAM_TOOLS === '1';

export const LIMITS = {
  sessionsPerIpPerHour: num('SAKHI_SESSIONS_PER_IP_HOUR', 30),
  turnsPerSession: num('SAKHI_TURNS_PER_SESSION', 80),
  listenSecPerSession: num('SAKHI_LISTEN_SEC_PER_SESSION', 20 * 60),
  dailyBudgetInr: num('SAKHI_DAILY_BUDGET_INR', 3000),
};

const TEAM_PATHS = /^\/(review\.html|review\/|cutoffs\.html|stt-lab\.(html|js)|mic-test\.(html|js)|api\/lab\/|api\/session\/cost)/;
/** A team-only page or endpoint, refused in production. */
export const isTeamPath = (pathname) => !teamTools && TEAM_PATHS.test(pathname);

/** The caller's address. Cloud Run puts the real one first in X-Forwarded-For. */
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || 'unknown';
}

/** A sliding-window counter per key (in memory: one server instance). */
export class RateLimit {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  /** Count a hit; false when over the limit. */
  hit(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) { this.hits.set(key, list); return false; }
    list.push(now); this.hits.set(key, list);
    if (this.hits.size > 50_000) this.prune(now);
    return true;
  }
  prune(now = Date.now()) { for (const [k, l] of this.hits) if (!l.some((t) => now - t < this.windowMs)) this.hits.delete(k); }
}

export const sessionStarts = new RateLimit(LIMITS.sessionsPerIpPerHour, 60 * 60 * 1000);

/** May Sakhi's voice say this text? (Only checked in production.) */
export function maySpeak(text, session, fixedLines) {
  if (!production) return true;
  if (fixedLines.has(text)) return true;
  // The app may trim a repeated "Okay!" from the start of a line, so a line can be the end of one she said.
  return !!session && session.history.some((h) => h.who === 'sakhi' && (h.text === text || h.text.endsWith(text)));
}

