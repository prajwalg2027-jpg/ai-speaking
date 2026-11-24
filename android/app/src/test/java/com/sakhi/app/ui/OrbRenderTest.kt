package com.sakhi.app.ui

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.sakhi.app.conversation.Phase
import com.sakhi.app.ui.theme.Sakhi
import com.sakhi.app.ui.theme.SakhiTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The orb on its own in each phase (idle, speaking, listening, thinking), saved to build/screenshots for review
 * against the design (public/orb.js and the .o-* rules in public/styles.css). With motion: the teal cloud on the
 * wall while Sakhi speaks, the teal liquid on the learner's turn, the teal aura while thinking.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w420dp-h160dp-xxhdpi")
class OrbRenderTest {
    @get:Rule val compose = createComposeRule()

    private fun row(name: String, dark: Boolean, reducedMotion: Boolean) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SakhiTheme(dark = dark) {
                Row(Modifier.background(Sakhi.colors.bg).padding(12.dp)) {
                    for (phase in listOf(Phase.IDLE, Phase.SPEAKING, Phase.LISTENING, Phase.THINKING)) {
                        Box(Modifier.padding(4.dp)) { Orb(phase, { 0.45f }, reducedMotion, Modifier.size(92.dp)) }
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(1_600) // long enough for the hand-off and the thinking aura to settle
        val bmp = compose.onRoot().captureToImage().asAndroidBitmap()
        File("build/screenshots").apply { mkdirs() }.let { File(it, "$name.png").outputStream().use { o -> bmp.compress(Bitmap.CompressFormat.PNG, 100, o) } }
    }

    @Test fun orbLight() = row("orb-light", dark = false, reducedMotion = false)
    @Test fun orbDark() = row("orb-dark", dark = true, reducedMotion = false)
    @Test fun orbStill() = row("orb-still", dark = false, reducedMotion = true)
}
