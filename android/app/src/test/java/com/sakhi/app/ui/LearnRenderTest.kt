package com.sakhi.app.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.sakhi.app.learn.ChatItem
import com.sakhi.app.learn.ChatState
import com.sakhi.app.learn.HomeState
import com.sakhi.app.learn.LearnPage
import com.sakhi.app.learn.LearnUi
import com.sakhi.app.learn.LessonUi
import com.sakhi.app.net.AttemptResult
import com.sakhi.app.net.Correction
import com.sakhi.app.net.ConversationInfo
import com.sakhi.app.net.Exercise
import com.sakhi.app.net.LearnActivity
import com.sakhi.app.net.LearnProfile
import com.sakhi.app.net.LearnProgress
import com.sakhi.app.net.Lesson
import com.sakhi.app.net.LessonProgress
import com.sakhi.app.net.LessonState
import com.sakhi.app.ui.theme.SakhiTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** The learning screens, rendered on the JVM and saved to build/screenshots (learn-*.png) for review. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w393dp-h852dp-xxhdpi")
class LearnRenderTest {
    @get:Rule val compose = createComposeRule()

    private fun shot(name: String, ui: LearnUi, dark: Boolean = false) {
        compose.mainClock.autoAdvance = false
        compose.setContent { SakhiTheme(dark = dark) { LearnScreen(ui, { 0.3f }, LearnActions(placement = {}, account = {})) } }
        compose.mainClock.advanceTimeBy(1_000)
        val bmp = compose.onRoot().captureToImage().asAndroidBitmap()
        File("build/screenshots").apply { mkdirs() }.let { File(it, "$name.png").outputStream().use { o -> bmp.compress(Bitmap.CompressFormat.PNG, 100, o) } }
    }

    private val past = Lesson("past-simple-regular", "grammar", "Talking about yesterday", 1, "Use the past simple of regular verbs to talk about yesterday.",
        "Add -ed to most verbs: work → worked, play → played.", "When something happened and finished in the past, we use the past simple. For most verbs, just add -ed.",
        listOf("Yesterday I worked from home.", "She called her mother last night."), 5, LessonProgress("s1", "active", 3, 2))
    private val lessons = listOf(past,
        Lesson("articles", "grammar", "A, an and the", 1, summary = "A for any one thing, the for the one we both know.", exerciseCount = 5, completedTimes = 1),
        Lesson("work-words", "vocabulary", "Words for work", 2, summary = "Talk about your job and your day at work.", exerciseCount = 5))

    private val home = HomeState(false, LearnProfile("Asha", "balanced", level = 2, placementLevel = 2),
        LearnProgress(2, 2, null, LearnActivity(42, 5, 1, 6, 17), focus = listOf("past_simple", "articles")), lessons,
        listOf(ConversationInfo("c1", title = null, lastMessage = "Nice! What did you buy at the market?")))

    // One screen per test: a compose rule can only be given content once.
    @Test fun home() = shot("learn-home", LearnUi(LearnPage.Home, home))
    @Test fun homeDark() = shot("learn-home-dark", LearnUi(LearnPage.Home, home), dark = true)
    @Test fun chat() = shot("learn-chat", LearnUi(LearnPage.Chat("c1"), home, chat))
    @Test fun chatDark() = shot("learn-chat-dark", LearnUi(LearnPage.Chat("c1"), home, chat), dark = true)

    private val chat = ChatState("c1", loading = false, items = listOf(
            ChatItem("g", true, "Hi Asha! I'm Sakhi. What would you like to talk about today?", id = "g"),
            ChatItem("m1", false, "Yesterday I goed to the market with my sister", voice = true,
                corrections = listOf(Correction(original = "goed", corrected = "went", explanation = "Go is irregular: go → went."))),
            ChatItem("r1", true, "That sounds fun! What did you buy at the market?", id = "r1"),
            ChatItem("m2", false, "We buyed vegetables and fruits", checking = true),
            ChatItem("r2", true, "Lovely. Do you go every week?", id = "r2"),
        ))

    private val ex = Exercise("past/3", 3, "choose", "Which sentence is correct?", listOf("She call me yesterday.", "She called me yesterday.", "She calling me yesterday."))
    private val st = LessonState("s1", "active", 3, 2, 2, 5, "c9", past, ex)
    private val fill = st.copy(exercise = Exercise("past/2", 2, "fill_blank", "Last Sunday we ___ (play) cricket."), position = 2)

    @Test fun lesson() = shot("learn-lesson", LearnUi(LearnPage.LessonPage("s1"), home, lesson = LessonUi(false, st)))
    @Test fun lessonFeedback() = shot("learn-lesson-feedback", LearnUi(LearnPage.LessonPage("s1"), home,
        lesson = LessonUi(false, fill, AttemptResult("incorrect", "Not quite. Have another look and try again.", tryAgain = true, state = fill))))
    @Test fun lessonDone() = shot("learn-lesson-done", LearnUi(LearnPage.LessonPage("s1"), home,
        lesson = LessonUi(false, st.copy(status = "completed", correct = 4, total = 5, exercise = null))))
}
