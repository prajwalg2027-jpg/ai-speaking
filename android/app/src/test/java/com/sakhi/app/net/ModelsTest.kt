package com.sakhi.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The fixtures are real replies from server/session.js, so a server change that breaks the app fails here. */
class ModelsTest {
    private fun turn(name: String): Turn =
        SakhiJson.decodeFromString(javaClass.classLoader!!.getResource("turn_$name.json")!!.readText())

    @Test fun `the opening is in Hindi and listens with auto language`() {
        val t = turn("opening")
        assertEquals("hi-IN", t.say.first().lang)
        assertEquals(ListenSpec(1400, "auto"), t.listen)
        assertNull(t.card)
        assertNull(t.done)
    }

    @Test fun `a word task carries its card and where it appears`() {
        val t = turn("withCard")
        val card = assertNotNull(t.card).let { t.card!! }
        assertEquals("emoji", card.look)
        assertNotNull(card.band?.hi)
        assertNotNull(t.cue)
    }

    @Test fun `the result is read with missing skills left out`() {
        val r = turn("done").done!!
        assertEquals(2, r.level)
        assertEquals("Basic", r.name)
        assertNull(r.dims["pronunciation"])
        assertEquals(1, r.doingWell.size)
    }

    @Test fun `a turn request leaves out what it doesn't have`() {
        val json = SakhiJson.encodeToString(TurnRequest.serializer(), TurnRequest("s", "no_speech"))
        assertEquals("""{"sessionId":"s","event":"no_speech"}""", json)
    }

    @Test fun `the result screen's feedback is read whole, parts that are missing left out`() {
        val ins = SakhiJson.decodeFromString<Insights>(javaClass.classLoader!!.getResource("insights.json")!!.readText())
        assertEquals(3, ins.level)
        assertEquals(3, ins.answers.size)
        assertEquals(listOf("wake", "woke"), ins.answers[0].diff.filter { it.k != "same" }.take(2).map { it.t })
        assertEquals(4, assertNotNull(ins.ladder).rungs.size)
        assertEquals(2, ins.habit!!.examples.size)
        assertEquals(listOf("and", "because", "then"), ins.counts!!.joiningWords)
        val bare = SakhiJson.decodeFromString<Insights>("""{"status":"ready","level":1,"counts":{"answers":0}}""")
        assertNull(bare.best)
        assertEquals(true, bare.isEmpty)
    }
}
