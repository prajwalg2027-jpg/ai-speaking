package com.sakhi.app.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class SpeechMeterTest {
    private fun SpeechMeter.feed(rms: Float, frames: Int, start: Long): Long {
        var t = start
        repeat(frames) { t += 20; frame(rms, 20f, t) }
        return t
    }

    @Test fun `speech start is remembered through short dips and forgotten after 400 ms of quiet`() {
        val m = SpeechMeter()
        var t = m.feed(0.001f, 50, 0) // settle the noise floor
        assertNull(m.speechOnsetAtMs)
        t = m.feed(0.2f, 10, t)
        val onset = m.speechOnsetAtMs
        assertNotNull(onset)
        t = m.feed(0.001f, 10, t) // 200 ms dip: same stretch of speech
        assertEquals(onset, m.speechOnsetAtMs)
        m.feed(0.001f, 15, t) // 500 ms quiet
        assertNull(m.speechOnsetAtMs)
    }

    @Test fun `timing counts pauses of a quarter second or more, not gaps inside words`() {
        val m = SpeechMeter()
        var t = m.feed(0.001f, 50, 0)
        m.startTiming()
        t = m.feed(0.001f, 10, t)  // silence before speaking isn't counted
        t = m.feed(0.2f, 25, t)    // 0.5 s voice
        t = m.feed(0.001f, 5, t)   // 0.1 s gap: inside a word
        t = m.feed(0.2f, 25, t)    // 0.5 s
        t = m.feed(0.001f, 30, t)  // 0.6 s pause
        t = m.feed(0.2f, 25, t)    // 0.5 s
        m.feed(0.001f, 20, t)      // trailing silence isn't counted
        val timing = m.stopTiming()!!
        assertEquals(listOf(0.6), timing.pauses)
        assertEquals(1.5, timing.voicedSec, 0.01)
        assertEquals(2.2, timing.spanSec, 0.01)
    }

    @Test fun `no speech means no timing`() {
        val m = SpeechMeter()
        m.startTiming(); m.feed(0.001f, 30, 0)
        assertNull(m.stopTiming())
    }
}
