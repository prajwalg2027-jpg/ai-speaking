package com.sakhi.app.audio

import kotlin.math.max
import kotlin.math.min

/** Timing of one answer, for fluency: first to last voiced moment, voiced time, and the pauses (each ≥ 0.25 s). */
data class SpeechTiming(val spanSec: Double, val voicedSec: Double, val pauses: List<Double>)

/**
 * Turns mic frames into "is the learner speaking?": a running noise floor, a speaking threshold above it,
 * where the current stretch of speech began, and (while measuring) the pauses between words.
 * Ported from public/audio.js so the app and the web app judge speech the same way. 
 * Frames come from the mic thread; timing is started and stopped from the conversation.
 */
class SpeechMeter {
    var noiseFloor = 0.01f
        private set
    val threshold: Float get() = max(0.012f, noiseFloor * 3)

    /** When the current stretch of speech began (clock ms), or null in silence. Kept through dips inside words. */
    @Volatile var speechOnsetAtMs: Long? = null
        private set
    @Volatile var lastLoudAtMs: Long = Long.MIN_VALUE / 2
        private set

    private var quietMs = 0f
    private var timing: MutableList<Pair<Boolean, Float>>? = null

    /** One frame: its RMS (0..1), its length in ms, and the clock time at its end. Returns the orb level (0..1). */
    @Synchronized fun frame(rms: Float, ms: Float, nowMs: Long): Float {
        val nf = noiseFloor
        // Drops quickly in quiet, rises very slowly, capped so a loud room can't hide speech.
        noiseFloor = min(0.015f, if (rms < nf) nf * 0.8f + rms * 0.2f else nf * 0.999f + rms * 0.001f)
        val t = threshold
        if (rms > t * 2) lastLoudAtMs = nowMs
        if (rms > t) {
            if (speechOnsetAtMs == null) speechOnsetAtMs = nowMs - ms.toLong()
            quietMs = 0f
        } else {
            quietMs += ms
            if (quietMs > 400) speechOnsetAtMs = null
        }
        timing?.add((rms > t) to ms)
        return min(1f, rms / (t * 6))
    }

    @Synchronized fun startTiming() { timing = mutableListOf() }

    /** Stop measuring; null if they never spoke. Dips under 0.25 s are gaps inside words, not pauses. */
    @Synchronized fun stopTiming(): SpeechTiming? {
        val frames = timing ?: emptyList()
        timing = null
        val first = frames.indexOfFirst { it.first }
        val last = frames.indexOfLast { it.first }
        if (first < 0) return null
        var span = 0f; var voiced = 0f; var gap = 0f
        val pauses = mutableListOf<Double>()
        for (i in first..last) {
            val (v, ms) = frames[i]
            span += ms
            if (v) {
                voiced += ms
                if (gap >= 250) pauses += round2(gap / 1000.0)
                gap = 0f
            } else gap += ms
        }
        return SpeechTiming(round2(span / 1000.0), round2(voiced / 1000.0), pauses)
    }

    private fun round2(v: Double) = Math.round(v * 100) / 100.0
}
