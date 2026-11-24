// The tutor runtime: the one entry point for a learner's message, in free conversation or in a lesson.
//
//   respond({ userId, conversationId, message, channel, clientMessageId, sttConfidence }, { onReply })
//
// 1. Check the input and that the conversation is the learner's.
// 2. Safe to retry: a message with a client id already answered returns the stored answer (nothing runs twice).
// 3. Save the learner's message, then gather context: profile, memory, recent messages, the lesson (if any).
// 4. One tutor turn (server/learning/tutor.js): the reply goes out first (onReply), then corrections are filtered
//    by the correction policy and, with strategy B, checked.
// 5. Save the reply, the corrections and the learning evidence in one transaction; update the level estimate.
// 6. Every few learner messages (or when they say "forget"), a memory note in the background (memory.js).
//
// startConversation() opens a free-practice conversation: earlier conversations' notes are written first (briefly
// waited for), then Sakhi greets the learner with something she remembers, or the plain greeting.
//
// The AI's answer is validated before anything is saved; if it fails, the learner's message stays saved without a
// reply, and retrying with the same client id carries on from there.
import { z } from 'zod';
import * as settings from '../settings.js';
import { structured as defaultStructured } from '../llm/index.js';
import * as repo from './repo.js';
import { tutorTurn } from './tutor.js';
import * as lessons from './lessons.js';
import * as memoryStore from './memory.js';

export const RespondInput = z.strictObject({
  userId: z.uuid(),
  conversationId: z.uuid(),
  message: z.string().trim().min(1, 'message is empty').max(1000, 'message is too long (1000 characters at most)'),
  channel: z.enum(['text', 'voice']).default('text'),
  clientMessageId: z.string().trim().min(1).max(100).nullable().default(null),
  sttConfidence: z.number().min(0).max(1).nullable().default(null),
});

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** The API's view of corrections (camelCase, without internal columns). */
export const correctionView = (c) => ({ id: c.id, original: c.original, corrected: c.corrected, category: c.category, concept: c.concept_key ?? c.concept, explanation: c.explanation, severity: c.severity });

export function createRuntime({ structured = defaultStructured } = {}) {
  async function respond(input, { onReply } = {}) {
    const parsed = RespondInput.safeParse(input);
    if (!parsed.success) throw fail(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    const { userId, conversationId, message, channel, clientMessageId, sttConfidence } = parsed.data;

    const conv = await repo.conversation(conversationId);
    if (!conv || conv.user_id !== userId) throw fail(404, 'conversation not found');

    // A retry of a message that was already answered: return the stored answer.
    let learner = await repo.learnerMessageByClientId(conv.id, clientMessageId);
    if (learner) {
      const stored = await repo.replyTo(learner.id);
      if (stored) {
        const m = stored.reply.metadata || {};
        onReply?.({ reply: stored.reply.content, encouragement: m.encouragement ?? null, followUpQuestion: m.followUpQuestion ?? null });
        return result({ conv, learner, reply: stored.reply, corrections: stored.corrections, meta: m, replayed: true });
      }
    } else {
      if (await repo.messagesToday(userId) >= settings.get('limits').learnMessagesPerDay) throw fail(429, 'daily practice limit reached', { reason: "That's a lot of practice for one day! Let's continue tomorrow." });
      learner = await repo.addLearnerMessage({ conversationId: conv.id, content: message, channel, clientMessageId, metadata: sttConfidence == null ? {} : { sttConfidence } });
      if (!learner) throw fail(409, 'this message is already being answered');
    }

    const cfg = { corrections: settings.get('corrections'), conversation: settings.get('conversation') };
    const [profile, memory, learnerMemory, history] = await Promise.all([
      repo.profile(userId, cfg.corrections.defaultIntensity),
      repo.memory(userId),
      memoryStore.recall(userId, { excludeConversationId: conv.id }).catch((e) => { console.warn('[memory] recall failed:', e.message); return null; }),
      repo.messages(conv.id, { limit: cfg.conversation.historyMessages, excludeId: learner.id }),
    ]);
    const lessonCtx = conv.mode === 'lesson' && conv.lesson_session_id ? await lessons.context(conv.lesson_session_id) : {};

    let turn;
    try {
      turn = await tutorTurn({
        structured, settings: cfg, message: learner.content, channel: learner.channel, mode: conv.mode,
        intensity: profile.correctionIntensity, profile, memory: { ...memory, facts: profile.facts, learner: learnerMemory },
        history: history.map((m) => ({ role: m.role, content: m.content })), lesson: lessonCtx.lesson, exercise: lessonCtx.exercise, onReply,
      });
    } catch (e) {
      console.warn(`[learn] tutor turn failed (${e.kind || 'error'}): ${e.message}`);
      throw fail(502, 'Sakhi could not answer just now', { reason: 'Sorry, I lost my train of thought. Please send that again.', kind: e.kind });
    }

    const saved = await repo.saveTurn({ userId, conversationId: conv.id, learnerMessage: learner, turn, channel: learner.channel });
    if (saved.duplicate) {
      const stored = await repo.replyTo(learner.id);
      return result({ conv, learner, reply: stored.reply, corrections: stored.corrections, meta: stored.reply.metadata, replayed: true });
    }
    repo.updateLevel(userId).catch((e) => console.warn('[learn] level update failed:', e.message));
    maybeNote(userId, conv.id, learner.content);
    return result({ conv, learner, reply: saved.reply, corrections: saved.corrections, meta: saved.reply.metadata, replayed: false });
  }

  /** A memory note in the background when enough is new, or at once when the learner asks Sakhi to forget. */
  function maybeNote(userId, conversationId, message) {
    const cfg = settings.get('memory');
    if (!cfg.enabled) return;
    memoryStore.inBackground(async () => {
      if (!memoryStore.asksToForget(message) && await memoryStore.unreadCount(conversationId) < cfg.everyMessages) return;
      await memoryStore.noteConversation({ userId, conversationId, structured });
    });
  }

  /** A new free-practice conversation with Sakhi's first line. → { conversation, greeting (the saved message) } */
  async function startConversation({ userId, title = null, profile, waitMs = 8000 }) {
    if (settings.get('memory').enabled) {
      // Earlier conversations the memory hasn't read yet: note them now, so the greeting can use them.
      const pending = Promise.all((await memoryStore.unnoted(userId)).map((id) => memoryStore.noteConversation({ userId, conversationId: id, structured })
        .catch((e) => console.warn(`[memory] note failed (${e.kind || 'error'}): ${e.message}`))));
      let timer;
      await Promise.race([pending, new Promise((r) => { timer = setTimeout(r, waitMs); })]).finally(() => clearTimeout(timer));
    }
    const personal = await memoryStore.greeting({ userId, profile, structured });
    const conversation = await repo.createConversation({ userId, mode: 'conversation', title });
    const greeting = await repo.addTutorMessage({ conversationId: conversation.id, content: personal?.text || plainGreeting(profile?.name),
      metadata: personal ? { kind: 'greeting', personal: true, askedAbout: personal.askedAbout, provider: personal.provider, model: personal.model } : { kind: 'greeting' } });
    return { conversation, greeting };
  }

  return { respond, startConversation };
}

export const plainGreeting = (name) => `Hi${name ? ` ${name}` : ''}! I'm Sakhi. What would you like to talk about today? It can be anything — your day, your work, or something you're planning.`;

function result({ conv, learner, reply, corrections, meta, replayed }) {
  return {
    conversationId: conv.id,
    learnerMessage: { id: learner.id, content: learner.content, channel: learner.channel },
    reply: { id: reply.id, text: reply.content, encouragement: meta?.encouragement ?? null, followUpQuestion: meta?.followUpQuestion ?? null },
    corrections: corrections.map(correctionView),
    replayed,
    meta: meta ? { promptVersion: meta.promptVersion, strategy: meta.strategy, intensity: meta.intensity, provider: meta.provider, model: meta.model, replyMs: meta.replyMs, totalMs: meta.totalMs } : null,
  };
}

export const runtime = createRuntime();
