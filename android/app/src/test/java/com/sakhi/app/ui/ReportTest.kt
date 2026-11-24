package com.sakhi.app.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.longClick
import com.sakhi.app.conversation.Message
import com.sakhi.app.conversation.Phase
import com.sakhi.app.conversation.ReportReason
import com.sakhi.app.conversation.SessionState
import com.sakhi.app.conversation.UiState
import com.sakhi.app.ui.theme.SakhiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Reporting what Sakhi said (Google Play's AI-generated content policy). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w393dp-h852dp-xxhdpi")
class ReportTest {
    @get:Rule val compose = createComposeRule()

    private val line = "Cricket with friends, nice! What is the person doing?"

    @Test fun `pressing and holding one of Sakhi's replies reports that reply`() {
        var reported: String? = null
        compose.setContent {
            SakhiTheme {
                SakhiScreen(UiState(SessionState.LIVE, Phase.LISTENING, listOf(Message(1, true, line.split(" ")))), { 0f }, reducedMotion = true,
                    onOrb = {}, onRestart = {}, onLogoLongPress = null, micBlocked = false, onAllowMic = {}, onReport = { reported = it })
            }
        }
        compose.onNodeWithText(line).performTouchInput { longClick() }
        assertEquals(line, reported)
    }

    @Test fun `choose a reason, send, and see thanks`() {
        var sent: ReportReason? = null
        compose.setContent { SakhiTheme { ReportDialog(line, onSend = { sent = it; true }, onDismiss = {}) } }
        compose.onNodeWithText("Send report").assertIsNotEnabled() // a reason first
        compose.onNodeWithText("Offensive or hurtful").performClick()
        save("13-report-dialog")
        compose.onNodeWithText("Send report").performClick()
        compose.waitForIdle()
        assertEquals(ReportReason.OFFENSIVE, sent)
        compose.onNodeWithText("Thank you").assertExists()
    }

    @Test fun `a report that doesn't arrive says so, and can be sent again`() {
        var tries = 0
        compose.setContent { SakhiTheme { ReportDialog(line, onSend = { tries++; false }, onDismiss = {}) } }
        compose.onNodeWithText("Wrong or misleading").performClick()
        compose.onNodeWithText("Send report").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Couldn't send it. Check your internet and try again.").assertExists()
        compose.onNodeWithText("Send report").performClick()
        compose.waitForIdle()
        assertEquals(2, tries)
    }

    @Test fun `before Sakhi has spoken there is nothing to send`() {
        compose.setContent { SakhiTheme { ReportDialog("", onSend = { error("nothing to send") }, onDismiss = {}) } }
        compose.onNodeWithText("Sakhi hasn't said anything yet. To report one of her replies, press and hold it.").assertExists()
        compose.onNodeWithText("Close").assertExists()
    }

    private fun save(name: String) {
        val bmp = compose.onNode(isDialog()).captureToImage().asAndroidBitmap()
        File("build/screenshots").apply { mkdirs() }.let { File(it, "$name.png").outputStream().use { o -> bmp.compress(Bitmap.CompressFormat.PNG, 100, o) } }
    }
}
