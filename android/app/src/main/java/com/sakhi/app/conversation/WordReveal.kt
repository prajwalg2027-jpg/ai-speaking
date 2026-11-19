package com.sakhi.app.conversation

/**
 * Sakhi's words appear in step with her voice. Bulbul gives no word timings, so each word's time is its share
 * of the line's characters times the audio length (estimated at ~14 characters a second until the whole clip
 * has arrived). Same rule as public/app.js.
 */
class WordReveal(text: String, pace: Double = 1.0) {
    val words: List<String> = text.split(Regex("\\s+")).filter { it.isNotEmpty() }
    private val starts: DoubleArray
    private val estimateSec: Double

    init {
        val chars = words.sumOf { it.length + 1 }.coerceAtLeast(1)
        var acc = 0
        starts = DoubleArray(words.size) { i -> (acc.toDouble() / chars).also { acc += words[i].length + 1 } }
        estimateSec = chars / 14.0 / (if (pace > 0) pace else 1.0)
    }

    /** How many words should be showing after `playedSec` of audio, with `receivedSec` received so far. */
    fun shown(playedSec: Double, receivedSec: Double, complete: Boolean): Int {
        val total = if (complete) receivedSec else maxOf(receivedSec, estimateSec)
        var n = 0
        while (n < starts.size && starts[n] * total <= playedSec + 0.05) n++
        return n
    }
}
