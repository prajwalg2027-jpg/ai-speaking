package com.sakhi.app.audio

import com.sakhi.app.audio.BargeInDetector.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BargeInDetectorTest {
    private val th = 0.02f

    @Test fun `learner speaking over Sakhi ducks her at once and stops her after 300 ms`() {
        val d = BargeInDetector()
        val actions = (1..20).map { d.frame(0.5f, th, 20f, it * 20L) }
        assertEquals(Action.SetVolume(0.25f), actions.first())
        val stopAt = actions.indexOf(Action.BargeIn)
        assertEquals(15, stopAt) // the 16th frame: 320 ms > 300 ms
        assertTrue(d.bargedIn)
    }

    @Test fun `a cough ducks her, then her volume comes back`() {
        val d = BargeInDetector()
        var t = 0L
        repeat(5) { t += 20; d.frame(0.5f, th, 20f, t) } // 100 ms bump
        val after = (1..60).map { t += 20; d.frame(0.001f, th, 20f, t) }
        assertTrue(Action.SetVolume(1f) in after)
        assertTrue(Action.BargeIn !in after)
    }

    @Test fun `quiet dips inside words don't reset the count`() {
        val d = BargeInDetector()
        var t = 0L
        val seq = List(8) { 0.5f } + List(2) { 0.001f } + List(10) { 0.5f }
        val actions = seq.map { t += 20; d.frame(it, th, 20f, t) }
        assertTrue(Action.BargeIn in actions)
    }
}
