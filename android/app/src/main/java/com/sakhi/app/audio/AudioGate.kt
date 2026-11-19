package com.sakhi.app.audio

/**
 * Decides where each mic frame goes. While listening for an answer, frames stream to Sarvam; otherwise they
 * stay in a 10 s ring (nothing is sent, nothing billed). When listening starts, buffered audio from where the
 * learner began talking is sent first, so no word is lost after an interruption. Mic thread and conversation
 * thread meet here, under one lock.
 */
class AudioGate(private val send: (ShortArray) -> Unit) {
    private val ring = PcmRing()
    private val lock = Any()
    @Volatile var streaming = false
        private set

    fun onFrame(pcm: ShortArray, endMs: Long) = synchronized(lock) {
        if (streaming) send(pcm) else ring.add(pcm, endMs)
    }

    /** Send buffered audio from clock time [fromMs] (never more than 3 s back), then stream live. → ms sent. */
    fun startStreaming(fromMs: Long, nowMs: Long): Long = synchronized(lock) {
        val pieces = ring.drainFrom(maxOf(fromMs, nowMs - MAX_LOOKBACK_MS))
        pieces.forEach(send)
        streaming = true
        pieces.sumOf { it.size } * 1000L / MicCapture.RATE
    }

    fun stopStreaming() = synchronized(lock) { streaming = false }

    fun reset() = synchronized(lock) { streaming = false; ring.clear() }

    companion object {
        /** Further back would be Sakhi's echo, not the learner. */
        const val MAX_LOOKBACK_MS = 3_000L
        const val ONSET_MARGIN_MS = 300L
        const val PREROLL_MS = 250L
    }
}
