package com.sakhi.app.conversation

/** Why an answer ended. */
enum class AnswerEnd(val wire: String) { SILENCE("silence"), MANUAL("manual"), MAX("max"), NO_SPEECH("no_speech"), LIVE_FAILED("live_failed") }

data class CollectedAnswer(
    val transcript: String,
    val language: String?,
    val languageConfidence: Double?,
    val speechSec: Double,
    val spoke: Boolean,
    val end: AnswerEnd,
)

/**
 * Collects one answer from Sarvam's realtime events (the rules of public/live.js listen()). An answer can span
 * several utterances: after each final transcript we wait a short grace period, and new speech keeps it open.
 * Pure and single-threaded: time comes in through [tick] and the event methods, so it's fully unit-testable.
 */
class AnswerCollector(
    private val startMs: Long,
    private val autoLanguage: Boolean,
    private val out: Output,
    private val graceMs: Long = 700,
    private val maxMs: Long = 45_000,
    private val nudgeMs: Long = 6_000,
    private val giveUpMs: Long = 12_000,
) {
    interface Output {
        fun partial(text: String) {}
        fun nudge() {}
        /** Re-detect the language at the next utterance (learners switch language mid-answer). */
        fun redetectLanguage() {}
        /** Ask Sarvam to end the open utterance now (pushes silence). */
        fun requestFinal() {}
        fun done(answer: CollectedAnswer)
    }

    private val accepted = mutableSetOf<Int>()
    private val open = mutableSetOf<Int>()
    private val pending = mutableListOf<String>()
    private var speechSec = 0.0
    private var language: String? = null
    private var confidence: Double? = null
    private var utterStartMs: Long? = null
    private var wallSpeechSec: Double? = null
    private var graceAt: Long? = null
    private var safetyAt: Long? = null
    private var finishing: AnswerEnd? = null
    private var nudged = false
    var finished = false
        private set

    val spoke: Boolean get() = accepted.isNotEmpty()

    fun speechStart(idx: Int, nowMs: Long) {
        if (finished) return
        accepted += idx; open += idx
        utterStartMs = nowMs
        graceAt = null; safetyAt = null
    }

    fun partial(idx: Int, text: String) {
        if (finished || idx !in accepted) return
        out.partial((pending + text).joinToString(" ").trim())
    }

    fun speechEnd(idx: Int, nowMs: Long) {
        if (finished || idx !in accepted) return
        wallSpeechSec = (nowMs - (utterStartMs ?: nowMs)) / 1000.0
        safetyAt = nowMs + 5_000 // the final transcript should follow quickly
    }

    fun final(idx: Int, text: String?, lang: String?, langConfidence: Double?, utteranceSec: Double?, nowMs: Long) {
        if (finished || idx !in accepted) return
        open -= idx
        text?.trim()?.takeIf { it.isNotEmpty() }?.let { pending += it }
        speechSec += utteranceSec ?: wallSpeechSec ?: 0.0
        if (lang != null) { language = lang; confidence = langConfidence }
        if (autoLanguage) out.redetectLanguage()
        graceAt = null; safetyAt = null
        finishing?.let { return finish(it) }
        if (open.isEmpty()) graceAt = nowMs + graceMs
    }

    fun failed() = finish(AnswerEnd.LIVE_FAILED)

    /** "Done speaking" (an orb tap). immediate = don't wait for the transcript of the open utterance. */
    fun manual(immediate: Boolean, nowMs: Long) {
        if (finished) return
        if (immediate || open.isEmpty()) finish(AnswerEnd.MANUAL)
        else if (finishing == null) requestFinal(AnswerEnd.MANUAL, nowMs)
    }

    fun tick(nowMs: Long) {
        if (finished) return
        graceAt?.let { if (nowMs >= it) return finish(AnswerEnd.SILENCE) }
        safetyAt?.let { if (nowMs >= it) return finish(finishing ?: AnswerEnd.SILENCE) }
        val t = nowMs - startMs
        if (accepted.isEmpty()) {
            if (!nudged && t > nudgeMs) { nudged = true; out.nudge() }
            if (t > giveUpMs) finish(AnswerEnd.NO_SPEECH)
        } else if (t > maxMs && finishing == null) requestFinal(AnswerEnd.MAX, nowMs)
    }

    private fun requestFinal(reason: AnswerEnd, nowMs: Long) {
        finishing = reason
        out.requestFinal()
        safetyAt = nowMs + 4_000
    }

    private fun finish(reason: AnswerEnd) {
        if (finished) return
        finished = true
        val end = if (reason == AnswerEnd.LIVE_FAILED || accepted.isNotEmpty()) reason else AnswerEnd.NO_SPEECH
        out.done(CollectedAnswer(pending.joinToString(" ").trim(), language, confidence, speechSec, accepted.isNotEmpty(), end))
    }
}
