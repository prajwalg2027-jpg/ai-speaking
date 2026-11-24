package com.sakhi.app.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.sakhi.app.conversation.CardState
import com.sakhi.app.conversation.Message
import com.sakhi.app.conversation.Phase
import com.sakhi.app.conversation.SessionState
import com.sakhi.app.conversation.UiState
import com.sakhi.app.net.Band
import com.sakhi.app.net.Card
import com.sakhi.app.ui.theme.SakhiTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The app is no longer locked to portrait (Android 16 ignores the lock on tablets and foldables anyway):
 * the main screen must still lay out, keep the orb on screen, and keep a readable width when the window
 * is wide or short. Saves the renders to build/screenshots for review.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LargeScreenRenderTest {
    @get:Rule val compose = createComposeRule()

    private fun words(t: String) = t.split(" ")
    private val live = UiState(
        SessionState.LIVE, Phase.LISTENING,
        listOf(
            Message(1, true, words("Cricket with friends, nice! Look at the picture. What is the person doing?"), shown = 99),
            Message(2, false, words("The person is running"), live = true),
        ),
        CardState(Card("🏃", "task", "emoji", Band("What is the person doing? Say it in English.", "यह व्यक्ति क्या कर रहा है?")), deal = 1),
    )

    private fun shot(name: String) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SakhiTheme(wideFrame = true) {
                SakhiScreen(live, { 0.4f }, reducedMotion = true, onOrb = {}, onRestart = {}, onLogoLongPress = null, micBlocked = false, onAllowMic = {})
            }
        }
        compose.mainClock.advanceTimeBy(2_000)
        compose.onNodeWithContentDescription("Listening. Tap when you are done").assertIsDisplayed()
        val orb = compose.onNodeWithContentDescription("Listening. Tap when you are done").getBoundsInRoot()
        val root = compose.onRoot().getBoundsInRoot()
        assertTrue("orb fits the window", orb.bottom <= root.bottom && orb.top >= root.top)
        val bmp = compose.onRoot().captureToImage().asAndroidBitmap()
        File("build/screenshots").apply { mkdirs() }.let { File(it, "$name.png").outputStream().use { o -> bmp.compress(Bitmap.CompressFormat.PNG, 100, o) } }
    }

    @Test @Config(sdk = [35], qualifiers = "w852dp-h393dp-land-xxhdpi")
    fun phoneLandscape() = shot("20-phone-landscape")

    @Test @Config(sdk = [35], qualifiers = "w1280dp-h800dp-land-xhdpi")
    fun tabletLandscape() {
        shot("21-tablet-landscape")
        // The conversation keeps a phone-like reading width, centred, rather than stretching across the tablet.
        val orb = compose.onNodeWithContentDescription("Listening. Tap when you are done").getBoundsInRoot()
        val root = compose.onRoot().getBoundsInRoot()
        val centre = (orb.left + orb.right) / 2
        assertTrue("orb is centred", centre > root.right / 2 - 4.dp && centre < root.right / 2 + 4.dp)
    }

    @Test @Config(sdk = [35], qualifiers = "w800dp-h1280dp-port-xhdpi")
    fun tabletPortrait() = shot("22-tablet-portrait")
}
