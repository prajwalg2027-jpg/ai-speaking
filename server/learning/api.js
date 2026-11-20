// The learning module's HTTP API, under /api/learn. Every request needs the phone login (when login is on); a
// learner only ever sees their own data. In local development without login, everything belongs to one local user.
//
//   GET    /api/learn/profile                         → profile and preferences
//   PATCH  /api/learn/preferences                     { correctionIntensity?, goals?, supportLanguage? }
//   GET    /api/learn/progress                        → level, activity, skills, focus areas
//   GET    /api/learn/conversations                   → recent conversations
//   POST   /api/learn/conversations                   { title? } → a new free-practice conversation, with Sakhi's greeting
//   GET    /api/learn/conversations/:id               → the conversation and its messages (with corrections)
//   POST   /api/learn/conversations/:id/messages      { message, channel?, clientMessageId?, sttConfidence? }
//            → JSON { reply, corrections, … }; or, with "Accept: text/event-stream", events as they're ready:
//              reply (as soon as the tutor has answered) → corrections (after the check) → done (everything) | error
//   GET    /api/learn/lessons                         → lessons with the learner's progress
//   GET    /api/learn/lessons/:id                     → one lesson (explanation, examples)
//   POST   /api/learn/lessons/:id/start               → a lesson session (new, or the one in progress)
//   GET    /api/learn/lesson-sessions/:id             → where the learner is in a lesson
//   POST   /api/learn/lesson-sessions/:id/attempts    { exerciseId, answer, channel?, clientAttemptId? } → verdict, feedback, next
//   POST   /api/learn/voice/transcribe                body: 16 kHz WAV (≤ 30 s) → { text, languageCode }
//   POST   /api/learn/messages/:id/speech             → Sakhi's voice for one of her replies (16-bit PCM, streamed)
import * as settings from '../settings.js';
import * as accounts from '../accounts.js';
import * as store from '../store.js';
import * as sarvam from '../sarvam.js';
import { loginEnabled } from '../auth.js';
import { production, LIMITS, RateLimit } from '../guard.js';
import { spentToday, addSpeechToText, shared } from '../costs.js';
import { readBody, readJson, send, fail, route, isUuid } from '../http.js';
import * as repo from './repo.js';
import * as lessons from './lessons.js';
import { runtime as defaultRuntime } from './runtime.js';
import { z } from 'zod';

const transcribeLimit = new RateLimit(300, 60 * 60 * 1000); // per learner per hour

/** The learner making the request. */
async function learner(req) {
  if (!repo.enabled()) throw fail(503, 'the learning module needs a database');
  const { user } = await accounts.identify(req, { required: loginEnabled() });
  if (user?.id) return user;
  if (!loginEnabled() && !production) {
    const u = await store.upsertUser({ firebaseUid: 'local-dev', phone: null });
    return { id: u.id, uid: 'local-dev', phone: null };
  }
  throw fail(401, 'login required');
}

function withinBudget() {
  if (production && spentToday() >= LIMITS.dailyBudgetInr) throw fail(503, 'busy', { reason: 'Sakhi is very busy today. Please try again tomorrow.' });
}

const Preferences = z.strictObject({
  correctionIntensity: z.enum(['gentle', 'balanced', 'strict']).optional(),
  goals: z.array(z.string().trim().min(1).max(100)).max(5).optional(),
  supportLanguage: z.enum(['hi-IN', 'en-IN']).nullable().optional(),
});

const greeting = (name) => `Hi${name ? ` ${name}` : ''}! I'm Sakhi. What would you like to talk about today? It can be anything — your day, your work, or something you're planning.`;

const conversationView = (c) => ({ id: c.id, mode: c.mode, title: c.title, lessonSessionId: c.lesson_session_id, startedAt: c.started_at, lastMessageAt: c.last_message_at, lastMessage: c.last_message, messageCount: c.message_count });
const messageView = (m) => ({
  id: m.id, role: m.role, content: m.content, channel: m.channel, createdAt: m.created_at, replyTo: m.reply_to,
  ...(m.role === 'tutor' ? { encouragement: m.metadata?.encouragement ?? null, followUpQuestion: m.metadata?.followUpQuestion ?? null } : {}),
  corrections: (m.corrections || []).map((c) => ({ id: c.id, original: c.original, corrected: c.corrected, category: c.category, concept: c.concept_key, explanation: c.explanation, severity: c.severity })),
});

async function ownConversation(user, id) {
  const c = isUuid(id) ? await repo.conversation(id) : null;
  if (!c || c.user_id !== user.id) throw fail(404, 'conversation not found');
  return c;
}

/**
 * Handle /api/learn/*. → true when handled.
 * @param {object} deps  { speak(res, {text, lang, pace}), runtime }
 */
export async function handleLearn(req, res, url, deps = {}) {
  if (!url.pathname.startsWith('/api/learn/')) return false;
  if (!settings.get('features').learningModule) throw fail(503, 'the learning module is switched off');
  const user = await learner(req);
  res.locals = { user: user.id };
  const p = url.pathname, m = req.method;
  let a;

  if (m === 'GET' && p === '/api/learn/profile') {
    const pr = await repo.profile(user.id, settings.get('corrections').defaultIntensity);
    return send(res, 200, { name: pr.name, correctionIntensity: pr.correctionIntensity, goals: pr.goals, supportLanguage: pr.supportLanguage, level: pr.level, placementLevel: pr.placementLevel, levelConfidence: pr.levelConfidence }), true;
  }
  if (m === 'PATCH' && p === '/api/learn/preferences') {
    const b = Preferences.safeParse(await readJson(req));
    if (!b.success) throw fail(400, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    await repo.profile(user.id, settings.get('corrections').defaultIntensity);
    await repo.updatePreferences(user.id, b.data);
    return send(res, 200, { ok: true }), true;
  }
  if (m === 'GET' && p === '/api/learn/progress') return send(res, 200, await repo.progress(user.id)), true;

  if (m === 'GET' && p === '/api/learn/conversations') return send(res, 200, { conversations: (await repo.conversations(user.id)).map(conversationView) }), true;
  if (m === 'POST' && p === '/api/learn/conversations') {
    const b = await readJson(req);
    const pr = await repo.profile(user.id, settings.get('corrections').defaultIntensity);
    const c = await repo.createConversation({ userId: user.id, mode: 'conversation', title: typeof b.title === 'string' ? b.title.slice(0, 100) : null });
    const g = await repo.addTutorMessage({ conversationId: c.id, content: greeting(pr.name), metadata: { kind: 'greeting' } });
    return send(res, 201, { conversation: conversationView(c), messages: [messageView(g)] }), true;
  }
  if (m === 'GET' && (a = route('/api/learn/conversations/:id', p))) {
    const c = await ownConversation(user, a.id);
    return send(res, 200, { conversation: conversationView(c), messages: (await repo.messages(c.id, { limit: 200 })).map(messageView) }), true;
  }
  if (m === 'POST' && (a = route('/api/learn/conversations/:id/messages', p))) {
    withinBudget();
    const c = await ownConversation(user, a.id);
    const b = await readJson(req);
    const input = { userId: user.id, conversationId: c.id, message: b.message, channel: b.channel || 'text', clientMessageId: b.clientMessageId ?? null, sttConfidence: b.sttConfidence ?? null };
    const rt = deps.runtime || defaultRuntime;
    if (!String(req.headers.accept || '').includes('text/event-stream')) return send(res, 200, await rt.respond(input)), true;
    // Streamed: the reply first, then the corrections once they're checked.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const r = await rt.respond(input, { onReply: (x) => event('reply', x) });
      event('corrections', { corrections: r.corrections });
      event('done', r);
    } catch (e) {
      event('error', { status: e.status || 500, error: e.message, reason: e.reason || null });
    }
    res.end();
    return true;
  }

  if (m === 'GET' && p === '/api/learn/lessons') return send(res, 200, { lessons: await lessons.list(user.id) }), true;
  if (m === 'GET' && (a = route('/api/learn/lessons/:id', p))) {
    const l = await lessons.lesson(a.id);
    if (!l) throw fail(404, 'lesson not found');
    return send(res, 200, l), true;
  }
  if (m === 'POST' && (a = route('/api/learn/lessons/:id/start', p))) return send(res, 200, await lessons.start(user.id, a.id)), true;
  if (m === 'GET' && (a = route('/api/learn/lesson-sessions/:id', p))) {
    if (!isUuid(a.id)) throw fail(404, 'lesson session not found');
    return send(res, 200, await lessons.state(user.id, a.id)), true;
  }
  if (m === 'POST' && (a = route('/api/learn/lesson-sessions/:id/attempts', p))) {
    withinBudget();
    if (!isUuid(a.id)) throw fail(404, 'lesson session not found');
    return send(res, 200, await lessons.attempt(user.id, a.id, await readJson(req))), true;
  }

  if (m === 'POST' && p === '/api/learn/voice/transcribe') {
    withinBudget();
    if (!transcribeLimit.hit(user.id)) throw fail(429, 'too many recordings; please wait a little');
    const wav = await readBody(req, 1_100_000); // 30 s of 16 kHz 16-bit mono, plus the header
    if (wav.length < 44 + 3200) throw fail(400, 'the recording is too short');
    const seconds = (wav.length - 44) / 32000;
    const r = await sarvam.transcribe(wav);
    addSpeechToText(shared, seconds);
    return send(res, 200, { text: r.transcript, languageCode: r.languageCode, seconds: +seconds.toFixed(1) }), true;
  }
  if (m === 'POST' && (a = route('/api/learn/messages/:id/speech', p))) {
    withinBudget();
    const msg = isUuid(a.id) ? await repo.tutorMessageOf(user.id, a.id) : null;
    if (!msg) throw fail(404, 'message not found');
    if (!deps.speak) throw fail(501, 'speech is not available');
    await deps.speak(res, { text: msg.content, lang: 'en-IN', pace: 1 });
    return true;
  }
  throw fail(404, 'not found');
}
