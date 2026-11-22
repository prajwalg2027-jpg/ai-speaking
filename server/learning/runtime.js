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
//
// The AI's answer is validated before anything is saved; if it fails, the learner's message stays saved without a
// reply, and retrying with the same client id carries on from there.
import { z } from 'zod';
import * as settings from '../settings.js';
import { structured as defaultStructured } from '../llm/index.js';
import * as repo from './repo.js';
import { tutorTurn } from './tutor.js';
import * as lessons from './lessons.js';

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
    const [profile, memory, history] = await Promise.all([
      repo.profile(userId, cfg.corrections.defaultIntensity),
      repo.memory(userId),
      repo.messages(conv.id, { limit: cfg.conversation.historyMessages, excludeId: learner.id }),
    ]);
    const lessonCtx = conv.mode === 'lesson' && conv.lesson_session_id ? await lessons.context(conv.lesson_session_id) : {};

    let turn;
    try {
      turn = await tutorTurn({
        structured, settings: cfg, message: learner.content, channel: learner.channel, mode: conv.mode,
        intensity: profile.correctionIntensity, profile, memory: { ...memory, facts: profile.facts },
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
    return result({ conv, learner, reply: saved.reply, corrections: saved.corrections, meta: saved.reply.metadata, replayed: false });
  }

  return { respond };
}

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
