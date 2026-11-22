package com.sakhi.app.audio

/**
 * Mic audio kept while we're not streaming to Sarvam (Sarvam bills every second it receives). Each piece
 * keeps the clock time at its end, so listening can start from exactly where the learner began talking —
 * however long the reconnect or the interruption took. Thread-safe.
 */
class PcmRing(private val sampleRate: Int = 16000, private val keepMs: Int = 10_000) {
    private class Piece(val pcm: ShortArray, val endMs: Long)
    private val pieces = ArrayDeque<Piece>()
    private var samples = 0

    @Synchronized fun add(pcm: ShortArray, endMs: Long) {
        pieces.addLast(Piece(pcm, endMs)); samples += pcm.size
        val keep = sampleRate.toLong() * keepMs / 1000
        while (pieces.size > 1 && samples - pieces.first().pcm.size >= keep) samples -= pieces.removeFirst().pcm.size
    }

    /** Everything from clock time `fromMs` on, oldest first (a piece that straddles it is cut), and empty the ring. */
    @Synchronized fun drainFrom(fromMs: Long): List<ShortArray> {
        val out = mutableListOf<ShortArray>()
        for (p in pieces) {
            if (p.endMs <= fromMs) continue
            val startMs = p.endMs - p.pcm.size * 1000L / sampleRate
            out += if (startMs >= fromMs) p.pcm
            else p.pcm.copyOfRange(((fromMs - startMs) * sampleRate / 1000).toInt().coerceIn(0, p.pcm.size), p.pcm.size)
        }
        clear()
        return out.filter { it.isNotEmpty() }
    }

    @Synchronized fun clear() { pieces.clear(); samples = 0 }
}
