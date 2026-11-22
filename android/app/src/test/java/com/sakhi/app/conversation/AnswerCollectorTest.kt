package com.sakhi.app.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnswerCollectorTest {
    private class Out : AnswerCollector.Output {
        var answer: CollectedAnswer? = null
        val partials = mutableListOf<String>()
        var nudged = false; var finals = 0; var redetects = 0
        override fun partial(text: String) { partials += text }
        override fun nudge() { nudged = true }
        override fun redetectLanguage() { redetects++ }
        override fun requestFinal() { finals++ }
        override fun done(answer: CollectedAnswer) { this.answer = answer }
    }

    @Test fun `an answer ends after the grace period, joining utterances`() {
        val o = Out(); val c = AnswerCollector(0, autoLanguage = true, out = o)
        c.speechStart(0, 100); c.partial(0, "I play"); c.speechEnd(0, 1500)
        c.final(0, "I play cricket.", "en-IN", 0.9, 1.4, 1600)
        c.tick(2000); assertNull(o.answer) // still within 700 ms grace
        c.speechStart(1, 2100) // they continue
        c.partial(1, "with friends")
        assertEquals("I play cricket. with friends", o.partials.last())
        c.final(1, "With my friends.", "en-IN", 0.8, 1.0, 3000)
        c.tick(3600); assertNull(o.answer)
        c.tick(3701)
        val a = o.answer!!
        assertEquals("I play cricket. With my friends.", a.transcript)
        assertEquals(AnswerEnd.SILENCE, a.end)
        assertEquals(2.4, a.speechSec, 1e-9)
        assertEquals(2, o.redetects)
    }

    @Test fun `silence nudges at 6 s and gives up at 12 s`() {
        val o = Out(); val c = AnswerCollector(0, autoLanguage = false, out = o)
        c.tick(6001); assertTrue(o.nudged); assertNull(o.answer)
        c.tick(12001)
        assertEquals(AnswerEnd.NO_SPEECH, o.answer!!.end)
        assertFalse(o.answer!!.spoke)
    }

    @Test fun `done tapped mid-sentence waits for the transcript of that sentence`() {
        val o = Out(); val c = AnswerCollector(0, autoLanguage = false, out = o)
        c.speechStart(0, 100)
        c.manual(immediate = false, nowMs = 2000)
        assertEquals(1, o.finals); assertNull(o.answer)
        c.final(0, "My name is Ravi", "en-IN", null, 1.8, 2400)
        assertEquals(AnswerEnd.MANUAL, o.answer!!.end)
        assertEquals("My name is Ravi", o.answer!!.transcript)
    }

    @Test fun `done tapped mid-sentence still ends if the transcript never comes`() {
        val o = Out(); val c = AnswerCollector(0, autoLanguage = false, out = o)
        c.speechStart(0, 100); c.manual(false, 2000)
        c.tick(5999); assertNull(o.answer)
        c.tick(6001); assertEquals(AnswerEnd.MANUAL, o.answer!!.end)
    }

    @Test fun `events for utterances it never saw start are ignored`() {
        val o = Out(); val c = AnswerCollector(0, autoLanguage = false, out = o)
        c.final(7, "echo of Sakhi", null, null, 1.0, 100)
        c.partial(7, "echo")
        assertTrue(o.partials.isEmpty()); assertNull(o.answer)
    }

    @Test fun `a dropped connection ends the answer as live_failed`() {
        val o = Out(); val c = AnswerCollector(0, autoLanguage = false, out = o)
        c.speechStart(0, 100); c.failed()
        assertEquals(AnswerEnd.LIVE_FAILED, o.answer!!.end)
    }

    @Test fun `a 45 s answer is asked to finish`() {
        val o = Out(); val c = AnswerCollector(0, autoLanguage = false, out = o)
        c.speechStart(0, 100); c.tick(45_001)
        assertEquals(1, o.finals)
        c.final(0, "long story", null, null, 44.0, 45_500)
        assertEquals(AnswerEnd.MAX, o.answer!!.end)
    }
}
