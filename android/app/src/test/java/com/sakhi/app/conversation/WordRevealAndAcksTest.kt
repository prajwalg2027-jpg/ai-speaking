package com.sakhi.app.conversation

import com.sakhi.app.net.Cue
import com.sakhi.app.net.Line
import com.sakhi.app.net.Turn
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class WordRevealAndAcksTest {
    @Test fun `words appear by their share of the characters`() {
        val r = WordReveal("aaaa bbbb cccc dddd") // each word a quarter
        assertEquals(1, r.shown(0.0, 4.0, complete = true))
        assertEquals(2, r.shown(1.0, 4.0, complete = true))
        assertEquals(4, r.shown(3.0, 4.0, complete = true))
    }

    @Test fun `before the whole clip arrives, the length is estimated`() {
        val r = WordReveal("aaaa bbbb cccc dddd") // 20 chars → ~1.43 s estimated
        assertEquals(r.shown(0.5, 0.2, complete = false), r.shown(0.5, 1.43, complete = true))
    }

    @Test fun `the reply's own Okay is dropped after a quick reaction, and the card cue moves with it`() {
        val t = Turn("s", say = listOf(Line("Okay! Here's a word puzzle. What is this?")), cue = Cue(0, 5))
        val out = dropRepeatedAck(t)
        assertEquals("Here's a word puzzle. What is this?", out.say[0].text)
        assertEquals(Cue(0, 4), out.cue)
    }

    @Test fun `the same for a reaction that came ahead of its turn`() {
        val out = dropRepeatedAck(listOf(Line("Okay! You went to the market."), Line("बहुत अच्छा।", lang = "hi-IN")))
        assertEquals(listOf("You went to the market.", "बहुत अच्छा।"), out.map { it.text })
        val plain = listOf(Line("You went to the market."))
        assertEquals(plain, dropRepeatedAck(plain))
    }

    @Test fun `ordinary openings are kept`() {
        val t = Turn("s", say = listOf(Line("Right now, tell me more.")))
        assertSame(t, dropRepeatedAck(t))
        val hindi = Turn("s", say = listOf(Line("ठीक है। अगला सवाल।", lang = "hi-IN")))
        assertSame(hindi, dropRepeatedAck(hindi))
    }

    @Test fun `silence is trimmed from a clip, keeping 40 ms either side`() {
        fun le(vararg s: Int) = s.flatMap { listOf((it and 0xFF).toByte(), (it shr 8).toByte()) }.toByteArray()
        val rate = 1000 // 40 ms = 40 samples
        val pcm = le(*IntArray(100) { 0 }, *IntArray(10) { 4000 }, *IntArray(100) { 0 })
        val out = trimSilence(pcm, rate)
        assertEquals((40 + 10 + 40) * 2, out.size) // 40 ms + the sound + 40 ms
        assertArrayEquals(le(4000), out.copyOfRange(80, 82))
    }
}
