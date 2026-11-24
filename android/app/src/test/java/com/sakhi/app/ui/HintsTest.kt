package com.sakhi.app.ui

import com.sakhi.app.conversation.Phase
import com.sakhi.app.conversation.SessionState
import com.sakhi.app.conversation.UiState
import org.junit.Assert.assertEquals
import org.junit.Test

class HintsTest {
    @Test fun `the hint follows the conversation`() {
        assertEquals(HintKey.TAP, hintKey(UiState()))
        assertEquals(HintKey.NOTICE, hintKey(UiState(notice = true)))
        val live = UiState(session = SessionState.LIVE)
        assertEquals(HintKey.SPEAKING, hintKey(live.copy(phase = Phase.SPEAKING)))
        assertEquals(HintKey.WAIT, hintKey(live.copy(phase = Phase.LISTENING, waitNudge = true)))
    }

    @Test fun `a test left midway: tap to carry on; a reply being sent again says so`() {
        assertEquals(HintKey.CONTINUE, hintKey(UiState(canResume = true)))
        assertEquals(HintKey.CONTINUE, hintKey(UiState(canResume = true, notice = true)))
        assertEquals(HintKey.RECONNECTING, hintKey(UiState(session = SessionState.LIVE, phase = Phase.THINKING, reconnecting = true)))
        assertEquals("Tap to carry on your test", hintLines(HintKey.CONTINUE, null).first)
    }

    @Test fun `second line is in the learner's language, else Hindi`() {
        assertEquals("ਸੁਣ ਰਹੀ ਹਾਂ…", hintLines(HintKey.LISTENING, "pa-IN").second)
        assertEquals("गोले को छूकर फिर कोशिश करें", hintLines(HintKey.NOTICE, "pa-IN").second) // Punjabi has no line: Hindi
        assertEquals("सुन रही हूँ…", hintLines(HintKey.LISTENING, null).second)
    }
}
