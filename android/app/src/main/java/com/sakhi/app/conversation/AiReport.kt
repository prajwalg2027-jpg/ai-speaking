package com.sakhi.app.conversation

import com.sakhi.app.net.Result

/**
 * Reporting what Sakhi (an AI) said. Google Play's AI-generated content policy asks for a way to flag offensive
 * AI output without leaving the app. A report goes to the server's event log as [REPORT_EVENT] (no server
 * change needed), with the reported words and the reason, so the team can review it.
 */
enum class ReportReason(val key: String, val label: String) {
    OFFENSIVE("offensive", "Offensive or hurtful"),
    HARMFUL("harmful", "Unsafe or harmful"),
    WRONG("wrong", "Wrong or misleading"),
    OTHER("other", "Something else"),
}

const val REPORT_EVENT = "ai_reply.reported"

/** The server keeps an event's properties under 4,000 characters; the words reported stay well inside that. */
const val REPORT_MAX_CHARS = 2000

/** The event's properties: the reason and the words reported (shortened if very long). */
fun reportProperties(text: String, reason: ReportReason): Map<String, String> =
    mapOf("reason" to reason.key, "text" to text.trim().take(REPORT_MAX_CHARS))

/**
 * What a report from the account menu is about: on the result screen, the feedback Sakhi wrote; otherwise her
 * last few lines (the newest last). Empty when she hasn't said anything yet.
 */
fun reportableText(state: UiState, lines: Int = 3): String {
    val r = state.result
    if (state.session == SessionState.RESULT && r != null) return resultText(r)
    return state.messages.filter { it.fromSakhi && !it.thinking && it.text.isNotBlank() }.takeLast(lines).joinToString("\n") { it.text }
}

/** The result's feedback, as Sakhi wrote it: the level's name, the summary, what went well, what to practise. */
fun resultText(r: Result): String = (listOf(r.name, r.blurb) + r.doingWell + r.practise).filter { it.isNotBlank() }.joinToString("\n")
