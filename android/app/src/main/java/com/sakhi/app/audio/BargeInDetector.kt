package com.sakhi.app.audio

/**
 * While Sakhi speaks: the moment the learner's voice is clearly above the noise (4× the speaking threshold),
 * her volume drops to a quarter; if it stays up for 300 ms (the counter drains at half speed, so dips inside
 * words don't reset it) she stops — a barge-in. A cough or a bump: volume comes back after 600 ms of quiet.
 * Same rules as public/audio.js.
 */
class BargeInDetector(
    private val duckVolume: Float = 0.25f,
    private val bargeInMs: Float = 300f,
    private val restoreAfterMs: Long = 600,
) {
    sealed interface Action {
        data class SetVolume(val volume: Float) : Action
        data object BargeIn : Action
        data object None : Action
    }

    private var loudMs = 0f
    private var duckedAtMs: Long? = null
    var bargedIn = false
        private set

    fun frame(rms: Float, threshold: Float, ms: Float, nowMs: Long, normalVolume: Float = 1f): Action {
        if (bargedIn) return Action.None
        var action: Action = Action.None
        if (rms > threshold * 4) {
            loudMs += ms
            if (duckedAtMs == null) { duckedAtMs = nowMs; action = Action.SetVolume(duckVolume) }
        } else loudMs = maxOf(0f, loudMs - ms / 2)
        if (loudMs > bargeInMs) { bargedIn = true; return Action.BargeIn }
        val ducked = duckedAtMs
        if (ducked != null && loudMs == 0f && nowMs - ducked > restoreAfterMs) {
            duckedAtMs = null
            action = Action.SetVolume(normalVolume)
        }
        return action
    }

    val wasDucked: Boolean get() = duckedAtMs != null
}
