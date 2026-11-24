package com.sakhi.app.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.sakhi.app.learn.ChatItem
import com.sakhi.app.learn.ChatState
import com.sakhi.app.learn.HomeState
import com.sakhi.app.learn.LearnPage
import com.sakhi.app.learn.LearnUi
import com.sakhi.app.learn.LearnViewModel
import com.sakhi.app.learn.LessonUi
import com.sakhi.app.learn.Mic
import com.sakhi.app.net.Correction
import com.sakhi.app.net.Lesson
import com.sakhi.app.ui.theme.Sakhi

/** What the learning screens can ask for (the activity wires these to [LearnViewModel]). */
data class LearnActions(
    val back: () -> Unit = {},
    val reload: () -> Unit = {},
    val practise: () -> Unit = {},
    val openConversation: (String) -> Unit = {},
    val openLesson: (String) -> Unit = {},
    val setIntensity: (String) -> Unit = {},
    val send: (String) -> Unit = {},
    val retry: () -> Unit = {},
    /** Tap the mic (the activity asks for the microphone first when needed). */
    val mic: () -> Unit = {},
    val play: (ChatItem) -> Unit = {},
    val answer: (String, Boolean) -> Unit = { _, _ -> },
    val next: () -> Unit = {},
    val askAboutLesson: () -> Unit = {},
    val clearHeard: () -> Unit = {},
    /** Back to the placement test (it can be taken again). */
    val placement: (() -> Unit)? = null,
    val account: (() -> Unit)? = null,
    val report: (String) -> Unit = {},
)

/** The learning area: home, a practice conversation, or a lesson. */
@Composable
fun LearnScreen(ui: LearnUi, micLevel: () -> Float, actions: LearnActions) {
    val c = Sakhi.colors
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(c.glow, c.bg), endY = 900f)).safeDrawingPadding()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
            when (val p = ui.page) {
                LearnPage.Home -> {
                    TopBar("Learn with Sakhi", onBack = null, onAccount = actions.account)
                    HomeView(ui.home, actions, Modifier.weight(1f))
                }
                is LearnPage.Chat -> {
                    TopBar(ui.chat.title ?: "Practise speaking", onBack = actions.back, onAccount = null)
                    ChatView(ui.chat, micLevel, actions, Modifier.weight(1f))
                }
                is LearnPage.LessonPage -> {
                    TopBar(ui.lesson.state?.lesson?.title ?: "Lesson", onBack = actions.back, onAccount = null)
                    LessonView(ui.lesson, micLevel, actions, Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun TopBar(title: String, onBack: (() -> Unit)?, onAccount: (() -> Unit)?) {
    val c = Sakhi.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) TextButton(onBack, Modifier.semantics { contentDescription = "Back" }) { Text("‹  Back", color = c.ink2) }
        else Box(Modifier.size(22.dp).clip(CircleShape).background(Brush.radialGradient(listOf(c.saffron, c.accent, c.accentDeep))))
        Text(title, Modifier.weight(1f).padding(start = 10.dp), style = MaterialTheme.typography.titleLarge, maxLines = 1)
        if (onAccount != null) TextButton(onAccount) { Text("Account", color = c.ink2) }
    }
}

// ---- home ----------------------------------------------------------------------------------------

@Composable
private fun HomeView(h: HomeState, a: LearnActions, modifier: Modifier) {
    val c = Sakhi.colors
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        val level = h.progress?.level ?: h.profile?.level
        if (level != null) Text("YOUR LEVEL · LEVEL $level OF 4", style = MaterialTheme.typography.labelSmall.copy(color = c.accentDeep))
        Text(h.profile?.name?.let { "Hi $it! What shall we do today?" } ?: "What shall we do today?", style = MaterialTheme.typography.bodyLarge)
        h.error?.let { ErrorLine(it, "Try again", a.reload) }
        PrimaryButton("Practise speaking with Sakhi", busy = h.starting, onClick = a.practise)
        Text("Talk about anything. Sakhi answers, then gently shows what to fix.", style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
        if (h.loading && h.lessons.isEmpty()) Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.accent) }

        h.progress?.let { p ->
            Panel {
                PanelTitle("Your progress")
                Text("${p.activity.messages} messages · ${p.activity.lessonsCompleted} lessons finished", style = MaterialTheme.typography.bodyMedium)
                if (p.activity.correctUsesThisWeek + p.activity.mistakesThisWeek > 0)
                    Text("This week: ${p.activity.correctUsesThisWeek} things said right, ${p.activity.mistakesThisWeek} to work on", style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
                if (p.focus.isNotEmpty()) {
                    Text("Practise next", Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelLarge)
                    p.focus.forEach { Text("•  ${concept(it)}", style = MaterialTheme.typography.bodyMedium) }
                }
                val mastered = p.skills.count { it.status == "mastered" }
                if (mastered > 0) Text("Mastered: $mastered", style = MaterialTheme.typography.bodySmall.copy(color = c.accent2))
            }
        }

        if (h.lessons.isNotEmpty()) {
            Text("Lessons", Modifier.padding(top = 4.dp), style = MaterialTheme.typography.titleLarge)
            h.lessons.forEach { LessonRow(it) { a.openLesson(it.id) } }
        }

        if (h.conversations.isNotEmpty()) {
            Text("Your conversations", Modifier.padding(top = 4.dp), style = MaterialTheme.typography.titleLarge)
            h.conversations.take(5).forEach { conv ->
                Panel(Modifier.clickable(role = Role.Button, onClickLabel = "Continue") { a.openConversation(conv.id) }) {
                    Text(conv.title ?: "Practice with Sakhi", style = MaterialTheme.typography.labelLarge)
                    conv.lastMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2), maxLines = 2) }
                }
            }
        }

        h.profile?.let { pr ->
            Panel {
                PanelTitle("How much should Sakhi correct?")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LearnViewModel.INTENSITIES.forEach { i ->
                        val on = pr.correctionIntensity == i
                        OutlinedButton({ a.setIntensity(i) }, Modifier.weight(1f),
                            colors = ButtonDefaults.outlinedButtonColors(containerColor = if (on) c.accent.copy(alpha = 0.18f) else c.surface)) {
                            Text(i.replaceFirstChar { it.uppercase() }, color = c.ink, maxLines = 1)
                        }
                    }
                }
                Text(when (pr.correctionIntensity) {
                    "gentle" -> "Only mistakes that change the meaning, one at a time."
                    "strict" -> "Every mistake, up to five at a time."
                    else -> "The important mistakes, up to three at a time."
                }, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
            }
        }
        a.placement?.let { TextButton(it, Modifier.fillMaxWidth()) { Text("Take the level test again", color = c.ink2) } }
    }
}

@Composable
private fun LessonRow(l: Lesson, onOpen: () -> Unit) {
    val c = Sakhi.colors
    Panel(Modifier.clickable(role = Role.Button, onClickLabel = "Open lesson", onClick = onOpen)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(l.title, style = MaterialTheme.typography.labelLarge)
                l.summary?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2), maxLines = 2) }
            }
            val pr = l.progress
            val status = when {
                pr != null && pr.status == "active" -> "${pr.position - 1}/${l.exerciseCount}"
                l.completedTimes > 0 -> "Done ✓"
                else -> l.level?.let { "Level $it" } ?: ""
            }
            Text(status, Modifier.padding(start = 10.dp), style = MaterialTheme.typography.bodySmall.copy(color = if (l.completedTimes > 0) c.accent2 else c.ink2))
        }
    }
}

// ---- practice chat -------------------------------------------------------------------------------

@Composable
private fun ChatView(s: ChatState, micLevel: () -> Float, a: LearnActions, modifier: Modifier) {
    val c = Sakhi.colors
    Column(modifier.fillMaxWidth().imePadding()) {
        val list = rememberLazyListState()
        FollowNewest(list, if (s.thinking) "thinking" else s.items.lastOrNull()?.key)
        if (s.loading) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.accent) }
        else LazyColumn(Modifier.weight(1f).fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, state = list,
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom)) {
            items(s.items, key = { it.key }) { m ->
                Box(Modifier.fillMaxWidth(), contentAlignment = if (m.fromSakhi) Alignment.CenterStart else Alignment.CenterEnd) {
                    if (m.fromSakhi) TutorBubble(m, playing = s.playing != null && s.playing == m.id, a) else LearnerBubble(m)
                }
            }
            if (s.thinking) item(key = "thinking") {
                Box(Modifier.clip(RoundedCornerShape(22.dp)).background(c.surface).padding(horizontal = 18.dp, vertical = 16.dp)) { Dots(c.accent) }
            }
        }
        s.error?.let { ErrorLine(it, if (s.retry != null) "Send again" else null, a.retry) }
        Composer(s.mic, enabled = !s.thinking && !s.loading, micLevel, onSend = a.send, onMic = a.mic)
    }
}

@Composable
private fun TutorBubble(m: ChatItem, playing: Boolean, a: LearnActions) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(22.dp)
    Column(Modifier.widthIn(max = 340.dp).clip(shape).background(c.surface).border(1.dp, c.line, shape).padding(horizontal = 18.dp, vertical = 12.dp)) {
        Text(m.text, style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (m.id != null) TextButton({ a.play(m) }) { Text(if (playing) "■ Stop" else "🔊 Listen", color = c.accentDeep, style = MaterialTheme.typography.bodySmall) }
            // Google Play's AI-generated content policy: a way to flag what the AI said.
            TextButton({ a.report(m.text) }) { Text("Report", color = c.ink2, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun LearnerBubble(m: ChatItem) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.widthIn(max = 320.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(Modifier.clip(shape).background(c.accent2.copy(alpha = if (c.dark) 0.22f else 0.12f))
            .border(1.dp, c.accent2.copy(alpha = 0.35f), shape).padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text((if (m.voice) "🎤 " else "") + m.text, style = MaterialTheme.typography.bodyMedium)
            if (m.failed) Text("Not sent", style = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.error))
        }
        if (m.checking) Text("Checking your English…", style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
        if (m.corrections.isNotEmpty()) CorrectionCard(m.corrections)
    }
}

/** The quiet card under the learner's message: what to say instead, and why. */
@Composable
fun CorrectionCard(list: List<Correction>) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(16.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.saffron.copy(alpha = if (c.dark) 0.16f else 0.14f))
        .border(1.dp, c.saffron.copy(alpha = 0.5f), shape).padding(12.dp).animateContentSize()
        .semantics { contentDescription = "Corrections" }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (list.size == 1) "ONE THING TO FIX" else "${list.size} THINGS TO FIX", style = MaterialTheme.typography.labelSmall.copy(color = c.accentDeep))
        list.forEach { k ->
            Column {
                Text(buildAnnotatedString {
                    withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough, color = c.ink2)) { append(k.original) }
                    append("  →  ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(k.corrected) }
                }, style = MaterialTheme.typography.bodyMedium)
                k.explanation?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2)) }
            }
        }
    }
}

/** Type a message, or tap the mic to say it (tap again when done). */
@Composable
private fun Composer(mic: Mic, enabled: Boolean, micLevel: () -> Float, onSend: (String) -> Unit, onMic: () -> Unit) {
    val c = Sakhi.colors
    var text by rememberSaveable { mutableStateOf("") }
    val send = { if (text.isNotBlank()) { onSend(text); text = "" } }
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (mic == Mic.Off) OutlinedTextField(text, { text = it }, Modifier.weight(1f), enabled = enabled,
            placeholder = { Text("Type in English, or tap 🎤") }, maxLines = 4, shape = RoundedCornerShape(16.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = c.surface, unfocusedContainerColor = c.surface))
        else Text(if (mic == Mic.Recording) "Listening… tap ■ when you're done" else "Writing down what you said…",
            Modifier.weight(1f).padding(horizontal = 6.dp), style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2))
        if (mic == Mic.Off && text.isNotBlank()) RoundButton("➤", "Send", enabled) { send() }
        else MicButton(mic, enabled || mic != Mic.Off, micLevel, onMic)
    }
}

@Composable
private fun MicButton(mic: Mic, enabled: Boolean, micLevel: () -> Float, onMic: () -> Unit) {
    val c = Sakhi.colors
    val label = when (mic) { Mic.Off -> "Speak"; Mic.Recording -> "Stop and send"; Mic.Transcribing -> "Working" }
    val level = if (mic == Mic.Recording) micLevel() else 0f
    Box(Modifier.size(56.dp).clip(CircleShape)
        .background(if (mic == Mic.Recording) c.rust.copy(alpha = 0.25f + 0.5f * level) else c.accentDeep)
        .clickable(enabled = enabled && mic != Mic.Transcribing, role = Role.Button, onClickLabel = label, onClick = onMic)
        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        when (mic) {
            Mic.Transcribing -> CircularProgressIndicator(Modifier.size(22.dp), color = c.onPrimary, strokeWidth = 2.dp)
            Mic.Recording -> Text("■", color = c.ink, style = MaterialTheme.typography.titleLarge)
            Mic.Off -> Text("🎤", style = MaterialTheme.typography.titleLarge)
        }
    }
}

@Composable
private fun RoundButton(glyph: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = Sakhi.colors
    Box(Modifier.size(56.dp).clip(CircleShape).background(c.accentDeep)
        .clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick)
        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Text(glyph, color = c.onPrimary, style = MaterialTheme.typography.titleLarge)
    }
}

// ---- lesson ---------------------------------------------------------------------------------------

@Composable
private fun LessonView(l: LessonUi, micLevel: () -> Float, a: LearnActions, modifier: Modifier) {
    val c = Sakhi.colors
    val s = l.state
    if (s == null) {
        Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (l.loading) CircularProgressIndicator(color = c.accent) else l.error?.let { ErrorLine(it, "Back", a.back) }
        }
        return
    }
    val lesson = s.lesson
    Column(modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        lesson.objective?.let { Text(it, style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2)) }
        // The explanation stays in reach while answering; it opens by itself before the first exercise.
        var open by rememberSaveable(s.sessionId) { mutableStateOf(s.position <= 1 && s.attempts == 0) }
        Panel(Modifier.clickable(role = Role.Button, onClickLabel = if (open) "Hide" else "Show") { open = !open }) {
            Row { PanelTitle("How it works", Modifier.weight(1f)); Text(if (open) "Hide" else "Show", color = c.accentDeep, style = MaterialTheme.typography.bodySmall) }
            if (open) {
                lesson.explanation?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                if (lesson.examples.isNotEmpty()) {
                    Text("Examples", Modifier.padding(top = 4.dp), style = MaterialTheme.typography.labelLarge)
                    lesson.examples.forEach { Text("•  $it", style = MaterialTheme.typography.bodyMedium) }
                }
            } else lesson.summary?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2)) }
        }

        val result = l.result
        if (s.status == "completed" && !l.awaitingNext) {
            Panel {
                Text("Lesson finished! 🎉", style = MaterialTheme.typography.titleLarge)
                Text("You got ${s.correct} of ${s.total} right.", style = MaterialTheme.typography.bodyLarge)
                Text("Now try it out: practise speaking with Sakhi and use what you learned.", style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2))
            }
            PrimaryButton("Back to lessons", busy = false, onClick = a.back)
        } else s.exercise?.let { ex ->
            Text("QUESTION ${ex.position} OF ${s.total}", style = MaterialTheme.typography.labelSmall.copy(color = c.accentDeep))
            Text(ex.prompt, style = MaterialTheme.typography.bodyLarge)
            if (result != null) Feedback(result.verdict, result.feedback, result.answer, result.explanation, result.corrections)
            l.error?.let { ErrorLine(it, null) {} }
            when {
                l.awaitingNext -> PrimaryButton(if (s.status == "completed") "See how you did" else "Next question", busy = false, onClick = a.next)
                ex.kind == "choose" && !ex.options.isNullOrEmpty() -> ex.options.orEmpty().forEach { o ->
                    OutlinedButton({ a.answer(o, false) }, Modifier.fillMaxWidth(), enabled = !l.busy, shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.outlinedButtonColors(containerColor = c.surface)) {
                        Text(o, color = c.ink, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 6.dp))
                    }
                }
                else -> AnswerBox(l, ex.id, micLevel, a)
            }
            if (l.busy) Text("Checking…", style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
        }
        if (s.conversationId != null) TextButton(a.askAboutLesson, Modifier.fillMaxWidth()) { Text("Ask Sakhi about this lesson", color = c.accentDeep) }
    }
}

@Composable
private fun AnswerBox(l: LessonUi, exerciseId: String, micLevel: () -> Float, a: LearnActions) {
    val c = Sakhi.colors
    var text by rememberSaveable(exerciseId, l.result?.feedback) { mutableStateOf("") }
    // A spoken answer fills the box, so the learner can check it before sending.
    LaunchedEffect(l.heard) { l.heard?.let { text = it } }
    val submit = { if (text.isNotBlank() && !l.busy) a.answer(text, l.heard != null && text == l.heard) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(text, { text = it; if (l.heard != null) a.clearHeard() }, Modifier.weight(1f), enabled = !l.busy && l.mic == Mic.Off,
            placeholder = { Text("Your answer") }, maxLines = 4, shape = RoundedCornerShape(16.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { submit() }),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = c.surface, unfocusedContainerColor = c.surface))
        MicButton(l.mic, !l.busy, micLevel, a.mic)
    }
    PrimaryButton("Check my answer", busy = l.busy, enabled = text.isNotBlank(), onClick = submit)
}

@Composable
private fun Feedback(verdict: String?, feedback: String, answer: String?, explanation: String?, corrections: List<Correction>) {
    val c = Sakhi.colors
    val good = verdict == "correct"
    val shape = RoundedCornerShape(16.dp)
    val tint = if (good) c.accent2 else c.saffron
    Column(Modifier.fillMaxWidth().clip(shape).background(tint.copy(alpha = 0.14f)).border(1.dp, tint.copy(alpha = 0.5f), shape).padding(14.dp)
        .semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(when (verdict) { "correct" -> "✓ Correct"; "partly" -> "Almost"; null -> "Hmm"; else -> "Not quite" }, style = MaterialTheme.typography.labelLarge)
        if (feedback.isNotBlank()) Text(feedback, style = MaterialTheme.typography.bodyMedium)
        answer?.let { Text(buildAnnotatedString { append("Answer: "); withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(it) } }, style = MaterialTheme.typography.bodyMedium) }
        explanation?.takeIf { it != feedback }?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2)) }
        if (corrections.isNotEmpty()) CorrectionCard(corrections)
    }
}

// ---- shared pieces ----------------------------------------------------------------------------------

@Composable
private fun Panel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(20.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.line, shape).then(modifier).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
}

@Composable private fun PanelTitle(t: String, modifier: Modifier = Modifier) = Text(t, modifier, style = MaterialTheme.typography.labelLarge)

@Composable
private fun PrimaryButton(text: String, busy: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Sakhi.colors
    Button(onClick, Modifier.fillMaxWidth().height(54.dp), enabled = enabled && !busy, shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accentDeep, contentColor = c.onPrimary,
            disabledContainerColor = c.accentDeep.copy(alpha = 0.5f), disabledContentColor = c.onPrimary)) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = c.onPrimary, strokeWidth = 2.dp)
        else Text(text, style = MaterialTheme.typography.labelLarge.copy(color = c.onPrimary))
    }
}

@Composable
private fun ErrorLine(message: String, action: String?, onAction: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.error))
        if (action != null) TextButton(onAction) { Text(action) }
    }
}

/** "past_simple" → "Past simple". */
fun concept(key: String): String = key.replace('_', ' ').replace('-', ' ').replaceFirstChar { it.uppercase() }

