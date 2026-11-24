package com.sakhi.app.ui

import com.sakhi.app.conversation.Phase
import com.sakhi.app.conversation.SessionState
import com.sakhi.app.conversation.UiState

/** The two-line hint under the orb: English, then the learner's language (public/ui.js LANGS). */
enum class HintKey { TAP, NOTICE, SPEAKING, LISTENING, THINKING, RESULT, WAIT, CONTINUE, RECONNECTING }

private val EN = mapOf(
    HintKey.TAP to "Tap and let’s talk", HintKey.NOTICE to "Tap the orb to try again", HintKey.SPEAKING to "You can interrupt anytime",
    HintKey.LISTENING to "Listening… pause when you’re done", HintKey.THINKING to "One moment…", HintKey.RESULT to "This is where we start",
    HintKey.WAIT to "Take your time. Whenever you’re ready.",
    HintKey.CONTINUE to "Tap to carry on your test", HintKey.RECONNECTING to "Reconnecting…",
)
private val NATIVE = mapOf(
    "hi" to mapOf(HintKey.TAP to "छूइए और बात कीजिए", HintKey.LISTENING to "सुन रही हूँ…", HintKey.WAIT to "आराम से। जब तैयार हों, बोलिए।",
        HintKey.SPEAKING to "बीच में भी बोल सकते हैं", HintKey.THINKING to "एक पल…", HintKey.NOTICE to "गोले को छूकर फिर कोशिश करें", HintKey.RESULT to "यहीं से शुरुआत करते हैं",
        HintKey.CONTINUE to "छूइए, टेस्ट वहीं से आगे बढ़ेगा", HintKey.RECONNECTING to "फिर से जुड़ रहे हैं…"),
    "pa" to mapOf(HintKey.TAP to "ਛੂਹੋ ਤੇ ਗੱਲ ਕਰੀਏ", HintKey.LISTENING to "ਸੁਣ ਰਹੀ ਹਾਂ…", HintKey.WAIT to "ਆਰਾਮ ਨਾਲ। ਜਦੋਂ ਤਿਆਰ ਹੋਵੋ, ਬੋਲੋ।", HintKey.SPEAKING to "ਵਿੱਚੋਂ ਵੀ ਬੋਲ ਸਕਦੇ ਹੋ", HintKey.THINKING to "ਇੱਕ ਪਲ…"),
    "ta" to mapOf(HintKey.TAP to "தொட்டுப் பேசலாம்", HintKey.LISTENING to "கேட்கிறேன்…", HintKey.WAIT to "நிதானமாக. தயாரானதும் பேசுங்கள்.", HintKey.SPEAKING to "இடையில் பேசலாம்", HintKey.THINKING to "ஒரு நொடி…"),
    "bn" to mapOf(HintKey.TAP to "ছুঁয়ে কথা বলুন", HintKey.LISTENING to "শুনছি…", HintKey.WAIT to "ধীরে সুস্থে। তৈরি হলে বলুন।", HintKey.SPEAKING to "মাঝখানেও বলতে পারেন", HintKey.THINKING to "এক মুহূর্ত…"),
)

fun hintKey(s: UiState): HintKey = when {
    s.reconnecting -> HintKey.RECONNECTING
    s.session == SessionState.IDLE && s.canResume -> HintKey.CONTINUE
    s.notice -> HintKey.NOTICE
    s.session == SessionState.IDLE -> HintKey.TAP
    s.session == SessionState.RESULT -> HintKey.RESULT
    s.phase == Phase.LISTENING && s.waitNudge -> HintKey.WAIT
    s.phase == Phase.SPEAKING -> HintKey.SPEAKING
    s.phase == Phase.LISTENING -> HintKey.LISTENING
    s.phase == Phase.THINKING -> HintKey.THINKING
    else -> HintKey.TAP
}

/** → (English line, second line). The second line falls back to Hindi where a language has no line for it. */
fun hintLines(key: HintKey, learnerLanguage: String?): Pair<String, String> {
    val lang = when (learnerLanguage) { "pa-IN" -> "pa"; "ta-IN" -> "ta"; "bn-IN" -> "bn"; else -> "hi" }
    return EN.getValue(key) to (NATIVE[lang]?.get(key) ?: NATIVE.getValue("hi")[key].orEmpty())
}
