package com.sakhi.app.conversation

import com.sakhi.app.net.Turn

/** The quick reactions played while Sakhi's reply is prepared (shared/assessment.js PHRASES.backchannels). */
val BACKCHANNELS = listOf("Okay.", "Right.", "I see.", "Hmm, okay.", "Got it.")

private val ACK = Regex(
    "^\\s*(?:okay|ok|alright|all right|right|got it|i see|hmm+|mm-?hmm|achha|great|nice|good|thanks|thank you)" +
        "(?:[,\\s]+(?:okay|thanks|thank you|got it))?\\s*[.!]+\\s+",
    RegexOption.IGNORE_CASE,
)

/** After a quick "Okay.", drop the reply's own opening "Okay!" so it isn't said twice (and move the card cue). */
fun dropRepeatedAck(turn: Turn): Turn {
    val first = turn.say.firstOrNull() ?: return turn
    if (first.lang != "en-IN") return turn
    val m = ACK.find(first.text) ?: return turn
    val rest = first.text.substring(m.value.length)
    if (rest.isBlank()) return turn
    val cut = m.value.trim().split(Regex("\\s+")).size
    val cue = turn.cue?.let { if (it.line == 0) it.copy(word = maxOf(0, it.word - cut)) else it }
    return turn.copy(say = listOf(first.copy(text = rest)) + turn.say.drop(1), cue = cue)
}

/** Cut the quiet lead-in and tail from a 16-bit PCM clip (little-endian bytes), keeping 40 ms either side. */
fun trimSilence(pcm: ByteArray, sampleRate: Int, quiet: Int = 500): ByteArray {
    val n = pcm.size / 2
    fun s(i: Int) = (pcm[2 * i + 1].toInt() shl 8) or (pcm[2 * i].toInt() and 0xFF)
    var a = 0; var b = n - 1
    while (a < n && kotlin.math.abs(s(a)) < quiet) a++
    while (b > a && kotlin.math.abs(s(b)) < quiet) b--
    if (a >= b) return pcm
    val pad = sampleRate / 25
    return pcm.copyOfRange(maxOf(0, a - pad) * 2, minOf(n, b + 1 + pad) * 2)
}
