package com.sakhi.app.conversation

import com.sakhi.app.net.Result
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AiReportTest {
    private fun sakhi(id: Long, t: String) = Message(id, true, t.split(" "))
    private fun you(id: Long, t: String) = Message(id, false, t.split(" "))

    @Test fun `a report carries the reason and the words`() {
        assertEquals(mapOf("reason" to "offensive", "text" to "That was rude."), reportProperties("  That was rude. ", ReportReason.OFFENSIVE))
    }

    @Test fun `very long words are shortened to fit the server's event limit`() {
        val p = reportProperties("a".repeat(10_000), ReportReason.WRONG)
        assertEquals(REPORT_MAX_CHARS, p.getValue("text").length)
        // The server drops events whose properties are over 4,000 characters once written as JSON.
        assertTrue(p.entries.sumOf { it.key.length + it.value.length + 6 } < 4000)
    }

    @Test fun `from the account menu, Sakhi's last three lines, not the learner's or the thinking dots`() {
        val state = UiState(SessionState.LIVE, messages = listOf(
            sakhi(1, "One."), you(2, "Hello"), sakhi(3, "Two."), sakhi(4, "Three."), sakhi(5, "Four."),
            Message(6, true, emptyList(), thinking = true),
        ))
        assertEquals("Two.\nThree.\nFour.", reportableText(state))
    }

    @Test fun `on the result screen, the feedback Sakhi wrote`() {
        val r = Result(3, name = "Conversational", blurb = "You speak with ease.", doingWell = listOf("Clear answers"), practise = listOf("Past tense"))
        assertEquals("Conversational\nYou speak with ease.\nClear answers\nPast tense", reportableText(UiState(SessionState.RESULT, result = r)))
    }

    @Test fun `nothing to report before Sakhi speaks`() {
        assertEquals("", reportableText(UiState()))
    }
}
