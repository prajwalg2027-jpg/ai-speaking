// One tutor turn, without saving anything: build the prompt, ask the AI, apply the correction policy and (strategy
// B) the check. Used by the runtime (which then saves the turn), the admin playground and the evaluation runner,
// so all three behave exactly alike.
//
// Strategy A ("single"): one call; its corrections pass the policy filter and are shown.
// Strategy B ("verify"): the same, plus a check of the corrections that passed the filter, only when there are any.
// Evaluations compare both on the SAME first call (`compare: true`), so the only difference is the check.
import { TutorOutput, repairTutorOutput } from './schemas.js';
import { buildTutorMessages, PROMPT_VERSION } from './prompts.js';
import { applyPolicy, validSignals } from './corrections.js';
import { verifyCorrections } from './verifier.js';
import { PRICES } from '../costs.js';

export const costInr = (usage) => usage ? ((usage.input || 0) * PRICES.llmPerMillion.input + (usage.output || 0) * PRICES.llmPerMillion.output) / 1e6 : 0;

/**
 * @param {object} p
 * @param {Function} p.structured     the AI provider layer (server/llm), injectable for tests
 * @param {object}   p.settings       { corrections, conversation } sections
 * @param {string}   p.message        the learner's last message
 * @param {'text'|'voice'} p.channel
 * @param {'conversation'|'lesson'} p.mode
 * @param {string}   p.intensity      gentle | balanced | strict
 * @param {object}   [p.profile] [p.memory] [p.history] [p.lesson] [p.exercise]
 * @param {'single'|'verify'} [p.strategy]  defaults to the settings
 * @param {boolean}  [p.compare]      run both strategies on the same first call (evaluations, playground)
 * @param {Function} [p.onReply]      called with the reply as soon as it's known, before corrections are checked
 */
export async function tutorTurn(p) {
  const { structured, settings, message, channel = 'text', mode = 'conversation', intensity = settings.corrections.defaultIntensity } = p;
  const strategy = p.strategy || settings.corrections.strategy;
  const messages = buildTutorMessages({ profile: p.profile, memory: p.memory, history: p.history || [], mode, channel, intensity, lesson: p.lesson, exercise: p.exercise, message });
  const t0 = performance.now();
  const main = await structured({ job: 'tutor', messages, schema: TutorOutput, schemaName: 'tutor_turn', repair: repairTutorOutput, maxTokens: 900 });
  const out = main.data;
  const replyMs = Math.round(performance.now() - t0);
  p.onReply?.({ reply: out.reply, encouragement: out.encouragement, followUpQuestion: out.follow_up_question });

  const policy = applyPolicy(out.corrections, {
    learnerText: message, intensity, channel, voiceSafe: settings.corrections.voiceSafe, max: settings.corrections.maxPerReply[intensity] ?? 3,
  });
  const single = { corrections: policy.kept, dropped: policy.dropped };
  let verified = null;
  if (strategy === 'verify' || p.compare) {
    const v = await verifyCorrections({ structured, message, corrections: policy.kept, channel });
    verified = { corrections: v.kept, dropped: [...policy.dropped, ...v.dropped], call: v.call, error: v.error };
  }
  const chosen = strategy === 'verify' ? verified : single;
  const totalMs = Math.round(performance.now() - t0);
  const usage = { input: (main.usage?.input || 0) + (verified?.call?.usage?.input || 0), output: (main.usage?.output || 0) + (verified?.call?.usage?.output || 0) };
  return {
    reply: out.reply,
    encouragement: out.encouragement,
    followUpQuestion: out.follow_up_question,
    corrections: chosen.corrections,
    verified: strategy === 'verify' ? !verified.error : null,
    proposed: out.corrections,
    dropped: chosen.dropped,
    signals: validSignals(out.learning_signals, message),
    strategy, intensity,
    meta: {
      promptVersion: PROMPT_VERSION, strategy, intensity, channel,
      provider: main.provider, model: main.model, attempts: main.attempts,
      replyMs, totalMs: strategy === 'verify' ? totalMs : replyMs,
      checkMs: verified?.call?.latencyMs ?? null, checkError: verified?.error ?? null,
      usage: strategy === 'verify' ? usage : main.usage,
      costInr: +costInr(strategy === 'verify' ? usage : main.usage).toFixed(4),
    },
    // Both strategies side by side, from the same first call (only with compare).
    compare: p.compare ? {
      single: { corrections: single.corrections, dropped: single.dropped, ms: replyMs, costInr: +costInr(main.usage).toFixed(4) },
      verify: { corrections: verified.corrections, dropped: verified.dropped, ms: totalMs, checkMs: verified.call?.latencyMs ?? null, checkError: verified.error, costInr: +costInr(usage).toFixed(4) },
    } : null,
  };
}
