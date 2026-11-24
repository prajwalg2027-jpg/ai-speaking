// A placement test that survives a break: the learner closed the app, took a call, lost the connection, or the
// server was released while they were in the middle. The test is saved to the database after every turn
// (accounts.afterTurn → freeze), and the app asks to carry it on (POST /api/session/resume) when the learner is
// back: Sakhi welcomes them back and asks the question they were on again. Within the window in Settings › Limits
// (resumeHours, 24 by default); after it the test is marked 'abandoned' and the next test starts afresh.
import * as settings from '../settings.js';
import * as store from '../store.js';
import { makeLedger } from '../costs.js';
import { voiceLanguage } from '../../shared/languages.js';
import * as classic from '../session.js';
import * as conversation from './conversation.js';

const modeOf = (s) => (s.mode === 'conversation' ? conversation : classic);
export const resumeHours = () => settings.get('limits').resumeHours ?? 24;

// What is only for the server's process: kept out of the saved test.
// saved/persist: what accounts.js has written; rec: mic audio not yet stored; joined/saying: the voice of a turn
// in flight; prev: the answer an interruption may be joined to (not across a break); inFlight: a turn being written.
const TRANSIENT = new Set(['saved', 'persist', 'rec', 'joined', 'saying', 'prev', 'inFlight', 'resultSaved']);

/** The test as plain JSON, to save. */
export function freeze(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) if (!TRANSIENT.has(k) && typeof v !== 'function') out[k] = v;
  return JSON.parse(JSON.stringify(out));
}

/** A saved test, live again in its module (its answers count as saved already). */
export function thaw(state) {
  const s = { ...state, prev: null, joined: null, saying: null, rec: null, at: state.at || Date.now() }; // at: when they last heard from her
  s.ledger = { ...makeLedger(), ...(state.ledger || {}) };
  s.saved = new WeakSet(s.answers || []);
  s.factsSaved = JSON.stringify(s.profile?.facts || []);
  s.nameSaved = s.profile?.name ?? null;
  return modeOf(s).adopt(s);
}

/** Has the learner said anything yet? (Before their first answer there is nothing to carry on.) */
export const started = (state) => (state?.history || []).some((h) => h.who === 'learner');

/** A test the server no longer holds (a release, or more than two hours away), if it is theirs and still in the window. → s or null */
export async function loadTest(sessionId, userId) {
  const hours = resumeHours();
  if (!(hours > 0) || !sessionId) return null;
  const r = await store.testState(sessionId);
  if (!r || r.status !== 'in_progress' || !r.state || r.userId !== (userId || null) || !(Date.now() - new Date(r.savedAt).getTime() < hours * 3600_000)) return null;
  return thaw(r.state);
}

/**
 * The test to carry on for this learner: the one named (if it is theirs and still running), or else their latest
 * one saved within the window. Loads it from the database when the server no longer holds it. Only a test they
 * have answered something in. → s or null
 */
export async function findTest({ userId, sessionId, inMemory }) {
  const hours = resumeHours();
  if (!(hours > 0)) return null;
  const live = sessionId && inMemory(sessionId);
  if (live) return (!userId || live.userId === userId) && started(live) ? live : null;
  let s = sessionId ? await loadTest(sessionId, userId) : null;
  if (!s && userId) {
    const saved = await store.openTest(userId, hours);
    if (saved) s = inMemory(saved.sessionId) || thaw(saved.state);
  }
  return s && started(s) ? s : null;
}

// ---- Sakhi's welcome back ---------------------------------------------------------------------------------
// Away a short while (a call, the phone locked): she just asks again. Longer: she welcomes them back by name.
export const SHORT_BREAK_MS = 3 * 60 * 1000;
export const AGAIN = { en: 'Sorry, we got cut off. Let me ask again.', hi: 'माफ़ कीजिए, बात बीच में रुक गई थी। मैं फिर से पूछती हूँ।' };
export const BACK = { en: "Welcome back! Let's carry on from where we stopped.", hi: 'चलिए, वहीं से आगे बढ़ते हैं।' };
const welcomeBack = (name) => `Welcome back, ${name}! Let's carry on from where we stopped.`;

/** Fixed lines (always allowed to be spoken, and generated ahead). */
export const fixedWelcomeLines = () => [AGAIN.en, AGAIN.hi, BACK.en, BACK.hi].map((text) => ({ text, lang: voiceLanguage(text), pace: 1 }));

/** Hindi too while Sakhi still speaks Hindi to them (the classic test's early part, or a learner who asked for it). */
const inHindi = (s) => (s.mode === 'conversation' ? !(s.answers || []).length : s.profile?.support === 'hi' || !!s.profile?.language);

export function welcomeLines(s, awayMs) {
  const name = s.profile?.name && /^[\p{L} .'-]{1,30}$/u.test(s.profile.name) ? s.profile.name : null;
  const short = awayMs < SHORT_BREAK_MS;
  const en = short ? AGAIN.en : name ? welcomeBack(name) : BACK.en;
  const lines = [{ text: en, lang: 'en-IN', pace: 1 }];
  if (inHindi(s)) { const hi = short ? AGAIN.hi : BACK.hi; lines.push({ text: hi, lang: voiceLanguage(hi), pace: 0.95 }); }
  return lines;
}

/** Sakhi's turn for a learner who is back: welcome, then the question again. Counts the comeback. */
export async function resumeTurn(s, awayMs) {
  const turn = modeOf(s).resumeTurn(s, welcomeLines(s, awayMs));
  s.resumes = (s.resumes || 0) + 1;
  await store.testResumed(s.id).catch((e) => console.error('[resume] counting the comeback failed:', e.message));
  return { ...turn, resumed: true, seq: s.seq || 0 };
}
