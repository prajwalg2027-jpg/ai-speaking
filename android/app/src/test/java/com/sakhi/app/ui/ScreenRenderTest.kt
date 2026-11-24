package com.sakhi.app.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.sakhi.app.conversation.CardState
import com.sakhi.app.conversation.Message
import com.sakhi.app.conversation.Phase
import com.sakhi.app.conversation.SessionState
import com.sakhi.app.conversation.UiState
import com.sakhi.app.net.Band
import com.sakhi.app.net.Card
import com.sakhi.app.net.SakhiJson
import com.sakhi.app.net.Turn
import com.sakhi.app.ui.theme.SakhiTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Renders the real screens on the JVM (no emulator) and saves them to build/screenshots for review.
 * It also fails if a screen can't be laid out or drawn.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w393dp-h852dp-xxhdpi")
class ScreenRenderTest {
    @get:Rule val compose = createComposeRule()

    private fun words(t: String) = t.split(" ")
    private val opening = Message(1, true, words("नमस्ते! मैं सखी हूँ। चलिए, पाँच मिनट की एक छोटी-सी बातचीत करते हैं।"), lang = "hi-IN")
    private val you = Message(2, false, words("In my free time I play cricket with my friends."))
    private val asking = Message(3, true, words("Cricket with friends, nice! Look at the picture. What is the person doing?"), shown = 9)
    private val card = CardState(Card("🏃", "task", "emoji", Band("What is the person doing? Say it in English.", "यह व्यक्ति क्या कर रहा है?")), deal = 1)

    private fun shot(name: String, state: UiState, dark: Boolean = false, micBlocked: Boolean = false) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SakhiTheme(dark = dark) {
                SakhiScreen(state, { 0.4f }, reducedMotion = true, onOrb = {}, onRestart = {}, onLogoLongPress = null, micBlocked = micBlocked, onAllowMic = {})
            }
        }
        compose.mainClock.advanceTimeBy(2_000)
        val bmp = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File("build/screenshots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun login(name: String, gate: com.sakhi.app.auth.Gate, dark: Boolean = false) {
        compose.mainClock.autoAdvance = false
        compose.setContent { SakhiTheme(dark = dark) { LoginFlow(gate, LoginActions(), "https://example.invalid/terms", "https://example.invalid/privacy") } }
        compose.mainClock.advanceTimeBy(500)
        val bmp = compose.onRoot().captureToImage().asAndroidBitmap()
        File("build/screenshots").apply { mkdirs() }.let { File(it, "$name.png").outputStream().use { o -> bmp.compress(Bitmap.CompressFormat.PNG, 100, o) } }
    }

    @Test fun loginPhone() = login("10-login-phone", com.sakhi.app.auth.Gate.Phone(number = "98765 4321", error = null))
    @Test fun loginCode() = login("11-login-code", com.sakhi.app.auth.Gate.Code("+919876543210", "v", code = "1234", resendIn = 24))
    @Test fun loginConsents() = login("12-login-consents", com.sakhi.app.auth.Gate.Consents(listOf("terms", "privacy", "age_18_plus", "recordings")), dark = true)

    @Test fun idle() = shot("01-idle", UiState())
    @Test fun speakingWithCard() = shot("02-speaking-card", UiState(SessionState.LIVE, Phase.SPEAKING, listOf(opening, you, asking), card))
    @Test fun listening() = shot("03-listening", UiState(SessionState.LIVE, Phase.LISTENING,
        listOf(opening, you, asking.copy(shown = 99), Message(4, false, words("The person is running"), live = true)), card), dark = true)
    @Test fun thinking() = shot("04-thinking", UiState(SessionState.LIVE, Phase.THINKING, listOf(opening, you, Message(5, true, emptyList(), thinking = true))))
    @Test fun micBlocked() = shot("05-mic", UiState(), micBlocked = true)
    @Test fun result() {
        val done = SakhiJson.decodeFromString<Turn>(javaClass.classLoader!!.getResource("turn_done.json")!!.readText()).done!!
        shot("06-result", UiState(SessionState.RESULT, Phase.IDLE, result = done))
    }
    private val insights by lazy { SakhiJson.decodeFromString<com.sakhi.app.net.Insights>(javaClass.classLoader!!.getResource("insights.json")!!.readText()) }
    private val done by lazy { SakhiJson.decodeFromString<Turn>(javaClass.classLoader!!.getResource("turn_done.json")!!.readText()).done!! }
    @Test fun resultWaitingForFeedback() = shot("08-result-loading", UiState(SessionState.RESULT, Phase.IDLE, result = done, insightsLoading = true))
    @Test fun resultWithFeedback() {
        val said = insights.answers[0].better
        val back = com.sakhi.app.net.SayBack(said, 0.86, 13, 15, said.split(" ").mapIndexed { i, w -> com.sakhi.app.net.SaidWord(w, i != 4 && i != 5) })
        shot("09-result-feedback", UiState(SessionState.RESULT, Phase.IDLE, result = done, insights = insights,
            sayBack = com.sakhi.app.conversation.SayBackState(results = mapOf(said to back))))
    }
    @Test fun resultWithFeedbackDark() = shot("10-result-feedback-dark", UiState(SessionState.RESULT, Phase.IDLE, result = done, insights = insights,
        sayBack = com.sakhi.app.conversation.SayBackState(text = insights.answers[0].better, phase = com.sakhi.app.conversation.SayPhase.RECORDING)), dark = true)
    @Test fun interrupted() = shot("07-cut-dark", UiState(SessionState.LIVE, Phase.LISTENING,
        listOf(you, Message(6, true, words("Okay. Now listen to"), cut = true), Message(7, false, emptyList(), live = true))), dark = true)
}
