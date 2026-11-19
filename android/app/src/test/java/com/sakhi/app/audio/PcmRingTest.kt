package com.sakhi.app.audio

import org.junit.Assert.assertEquals
import org.junit.Test

class PcmRingTest {
    private fun piece(n: Int, v: Int) = ShortArray(n) { v.toShort() }

    @Test fun `drains from a time, cutting the piece that straddles it`() {
        val r = PcmRing()
        r.add(piece(320, 1), 1020) // 1000..1020 ms
        r.add(piece(320, 2), 1040) // 1020..1040
        r.add(piece(320, 3), 1060) // 1040..1060
        val out = r.drainFrom(1030)
        assertEquals(2, out.size)
        assertEquals(160, out[0].size) // the second half of piece 2
        assertEquals(2, out[0][0].toInt())
        assertEquals(320, out[1].size)
        assertEquals(0, r.drainFrom(0).size) // drained
    }

    @Test fun `keeps only the last ten seconds`() {
        val r = PcmRing()
        var t = 0L
        repeat(1000) { t += 20; r.add(piece(320, it), t) } // 20 s
        val total = r.drainFrom(0).sumOf { it.size }
        assertEquals(10.0, total / 16000.0, 0.03)
    }
}
