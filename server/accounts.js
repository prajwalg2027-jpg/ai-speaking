// The customer side of the server: who is calling (phone login), their profile and consents, the app's
// event log, erasure, and saving each placement test as it happens (server/store.js).
import * as store from './store.js';
import * as recordings from './recordings.js';
import { caller, loginEnabled, firebaseEnabled, projectId } from './auth.js';
import { deleteFirebaseUser } from './gcp.js';
import { summarize } from './costs.js';
import * as sessions from './sessions.js';
import { CONFIG as SCORING } from './scoring.js';

// Firebase uid → our user id, so a turn doesn't need a database round trip just to know who's speaking.
const known = new Map();
const remember = (uid, id) => { known.set(uid, id); if (known.size > 20_000) known.delete(known.keys().next().value); };

/**
 * Who is calling. → { user: { id, uid, phone } | null }. Throws 401 when login is on and the token is
 * missing or bad. The first call from a new phone number creates the customer (and logs user.created).
 */
export async function identify(req, { required = loginEnabled() } = {}) {
  const who = await caller(req);
  if (!who) {
    if (required) throw Object.assign(new Error('login required'), { status: 401 });
    return { user: null };
  }
  if (who.userId) return { user: { id: who.userId, uid: who.uid, phone: who.phone, sessionId: who.sessionId } };
  let id = known.get(who.uid);
  if (!id && store.enabled()) {
    const u = await store.upsertUser({ firebaseUid: who.uid, phone: who.phone });
    id = u.id; remember(who.uid, id);
    if (u.created) await store.addEvent({ userId: id, name: 'user.created', properties: {} });
  }
  return { user: { id: id || null, uid: who.uid, phone: who.phone } };
}

/** Before a placement test: the customer must have agreed to everything required. → missing purposes */
export async function missingConsents(user) {
  if (!user?.id) return loginEnabled() ? [...store.REQUIRED_CONSENTS] : [];
  return store.missingConsents(user.id);
}

// ---- /api/me ----------------------------------------------------------------------

export async function me(user) {
  const u = await store.getUser(user.id);
  if (!u) return { id: null };
  return {
    id: u.id, phone: u.phone, name: u.name, attributes: u.attributes, createdAt: u.created_at,
    consents: await store.currentConsents(u.id), missingConsents: await store.missingConsents(u.id),
  };
}

const PURPOSES = new Set(['terms', 'privacy', 'recordings', 'age_18_plus']);
export async function saveConsents(user, list) {
  if (!Array.isArray(list) || !list.length || list.length > 10) throw Object.assign(new Error('consents: a list of 1–10'), { status: 400 });
  for (const c of list) if (!PURPOSES.has(c?.purpose) || typeof c.version !== 'string' || typeof c.granted !== 'boolean') throw Object.assign(new Error('consents: {purpose, version, granted}'), { status: 400 });
  await store.addConsents(user.id, list);
  await store.addEvent({ userId: user.id, name: 'consent.updated', properties: Object.fromEntries(list.map((c) => [c.purpose, c.granted])) });
  return { missingConsents: await store.missingConsents(user.id) };
}

export async function saveAttributes(user, attributes, source) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw Object.assign(new Error('attributes: an object'), { status: 400 });
  return store.setAttributes(user.id, attributes, source === 'signup' ? 'signup' : 'app');
}

/** Events from the app: up to 50 at a time, each { name, properties?, clientEventId, occurredAt?, sessionId? }. */
export async function saveEvents(user, events) {
  if (!Array.isArray(events) || events.length > 50) throw Object.assign(new Error('events: a list of up to 50'), { status: 400 });
  let saved = 0;
  for (const e of events) {
    if (typeof e?.name !== 'string' || !/^[a-z][a-z0-9_.]{1,60}$/.test(e.name) || typeof e.clientEventId !== 'string' || e.clientEventId.length > 100) continue;
    const props = e.properties && typeof e.properties === 'object' && !Array.isArray(e.properties) ? e.properties : {};
    if (JSON.stringify(props).length > 4000) continue;
    const at = e.occurredAt && !Number.isNaN(Date.parse(e.occurredAt)) ? new Date(e.occurredAt) : null;
    await store.addEvent({ userId: user.id, name: e.name, source: 'app', properties: props, sessionId: e.sessionId || null, clientEventId: e.clientEventId, occurredAt: at });
    saved++;
  }
  return { saved };
}

/** Erase everything personal (DPDP Act), including the Firebase login. */
export async function erase(user) {
  await sessions.forgetUser(user.id); // first: the session rows go with the account
  const r = await store.eraseUser(user.id, recordings.remove);
  known.delete(user.uid);
  if (firebaseEnabled() && !String(user.uid).startsWith('phone:')) await deleteFirebaseUser(projectId(), user.uid).catch((e) => console.warn('[accounts] Firebase account not deleted:', e.message));
  return { erased: true, recordings: r.recordings };
}

// ---- saving a placement test as it happens ------------------------------------------------

export async function testStarted(s, { user, client, appVersion }) {
  s.userId = user?.id || null;
  s.saved = new WeakSet(); s.factsSaved = '[]'; s.nameSaved = null;
  if (s.userId) s.recordConsent = (await store.currentConsents(s.userId)).recordings === true;
  await store.startAssessment({ userId: s.userId, sessionId: s.id, client, appVersion, scoringConfig: SCORING });
  await store.addEvent({ userId: s.userId, name: 'assessment.started', sessionId: s.id, properties: { client } });
}

/**
 * After each turn (in the background, in order per conversation): new answers, this answer's recording,
 * what Sakhi learned about them, and the result when the test ends.
 */
export function afterTurn(s, input) {
  s.persist = (s.persist || Promise.resolve()).then(() => saveTurn(s, input)).catch((e) => console.error('[accounts] saving the turn failed:', e.message));
  return s.persist;
}

async function saveTurn(s, input) {
  const audio = recordings.take(s);
  let lastAnswer = null;
  for (const a of s.answers) {
    if (s.saved.has(a)) continue;
    s.saved.add(a);
    lastAnswer = await store.saveAnswer(s.id, { ...a, itemId: a.item });
    await store.addEvent({ userId: s.userId, name: 'answer.submitted', sessionId: s.id, properties: { questionId: a.questionId, kind: a.kind, level: a.variantLevel, skipped: !!a.skipped } });
  }
  if (audio && input.event === 'answer' && s.userId && s.recordConsent) {
    s.recSeq = (s.recSeq || 0) + 1;
    const rec = await recordings.store({ userId: s.userId, sessionId: s.id, seq: s.recSeq, pcm: audio });
    await store.saveRecording({ userId: s.userId, sessionId: s.id, answerId: lastAnswer, ...rec });
  }
  if (s.userId) {
    if (s.profile?.name && s.profile.name !== s.nameSaved) { s.nameSaved = s.profile.name; await store.setAttributes(s.userId, { name: s.profile.name }, 'conversation'); }
    const facts = JSON.stringify(s.profile?.facts || []);
    if (facts !== s.factsSaved) { s.factsSaved = facts; await store.addConversationFacts(s.userId, s.profile.facts); }
  }
  if (s.done && s.result && !s.resultSaved) {
    s.resultSaved = true;
    await store.finishAssessment(s.id, s.result, summarize(s.ledger).totalInr);
  }
}
