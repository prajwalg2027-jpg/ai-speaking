package com.sakhi.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sakhi.app.conversation.CardState
import com.sakhi.app.conversation.Message
import com.sakhi.app.conversation.Phase
import com.sakhi.app.conversation.SessionState
import com.sakhi.app.conversation.UiState
import com.sakhi.app.net.Result
import com.sakhi.app.ui.theme.Sakhi
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/** The whole app is one screen: the conversation above, the card, the orb, and the hint. */
@Composable
fun SakhiScreen(
    state: UiState,
    level: () -> Float,
    reducedMotion: Boolean,
    onOrb: () -> Unit,
    onRestart: () -> Unit,
    onLogoLongPress: (() -> Unit)?,
    micBlocked: Boolean,
    onAllowMic: () -> Unit,
    onAccount: (() -> Unit)? = null,
    onStartLearning: () -> Unit = {},
) {
    val c = Sakhi.colors
    Box(
        Modifier.fillMaxSize()
            .background(Brush.verticalGradient(listOf(c.glow, c.bg), endY = 900f))
            .safeDrawingPadding(),
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
            Header(onLogoLongPress, onAccount)
            if (micBlocked) { MicScreen(onAllowMic); return@Column }
            if (state.session == SessionState.RESULT && state.result != null) {
                ResultView(state.result, onStartLearning, onRestart, Modifier.weight(1f)); return@Column
            }
            Conversation(state.messages, Modifier.weight(1f))
            AnimatedVisibility(state.card != null) { state.card?.let { TaskCard(it, reducedMotion) } }
            Box(Modifier.fillMaxWidth().padding(top = 12.dp), contentAlignment = Alignment.Center) {
                val label = when (state.phase) {
                    Phase.SPEAKING -> "Sakhi is speaking. Tap to interrupt"
                    Phase.LISTENING -> "Listening. Tap when you are done"
                    Phase.THINKING -> "Sakhi is thinking"
                    Phase.IDLE -> "Start talking with Sakhi"
                }
                Orb(
                    state.phase, level, reducedMotion,
                    Modifier.size(if (state.card != null) 96.dp else 132.dp).animateContentSize()
                        .clip(CircleShape)
                        .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onOrb)
                        .semantics { contentDescription = label },
                )
            }
            Hint(state)
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun Header(onLongPress: (() -> Unit)?, onAccount: (() -> Unit)?) {
    val c = Sakhi.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.padding(vertical = 14.dp).combinedClickable(enabled = onLongPress != null, onClick = {}, onLongClick = onLongPress),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(22.dp).clip(CircleShape).background(Brush.radialGradient(listOf(c.saffron, c.accent, c.accentDeep))))
            Text("Adam", Modifier.padding(start = 10.dp), style = MaterialTheme.typography.titleLarge)
        }
        Spacer(Modifier.weight(1f))
        if (onAccount != null) Box(
            Modifier.size(40.dp).clip(CircleShape).clickable(onClickLabel = "Account", role = Role.Button, onClick = onAccount)
                .semantics { contentDescription = "Account" },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(26.dp).clip(CircleShape).border(1.5.dp, c.ink2, CircleShape), contentAlignment = Alignment.TopCenter) {
                Box(Modifier.padding(top = 5.dp).size(8.dp).clip(CircleShape).background(c.ink2))
            }
        }
    }
}

@Composable
private fun Conversation(messages: List<Message>, modifier: Modifier) {
    val list = rememberLazyListState()
    LaunchedEffect(messages.size, messages.lastOrNull()?.text) { if (messages.isNotEmpty()) list.animateScrollToItem(messages.size - 1) }
    val lastSakhi = messages.lastOrNull { it.fromSakhi }?.id
    val lastYou = messages.lastOrNull { !it.fromSakhi }?.id
    LazyColumn(modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, state = list, verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom)) {
        items(messages, key = { it.id }) { m ->
            Box(Modifier.fillMaxWidth().animateItem(), contentAlignment = if (m.fromSakhi) Alignment.CenterStart else Alignment.CenterEnd) {
                if (m.fromSakhi) SakhiBubble(m, focus = m.id == lastSakhi) else YouBubble(m, focus = m.id == lastYou)
            }
        }
    }
}

@Composable
private fun SakhiBubble(m: Message, focus: Boolean) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(22.dp)
    val mod = Modifier.widthIn(max = 340.dp).clip(shape)
        .background(if (focus) c.surface else c.surface.copy(alpha = 0.6f))
        .then(if (focus) Modifier.border(1.5.dp, Brush.linearGradient(listOf(c.saffron, c.accent, c.rust)), shape) else Modifier.border(1.dp, c.line, shape))
        .padding(horizontal = 18.dp, vertical = 14.dp)
    Column(mod.animateContentSize()) {
        if (m.thinking) { Dots(c.accent); return@Column }
        val shown = m.shown.coerceAtMost(m.words.size)
        val text = buildAnnotatedString {
            m.words.forEachIndexed { i, w ->
                val color = when {
                    i >= shown -> Color.Transparent // laid out now, so the bubble doesn't grow word by word
                    i == shown - 1 && shown < m.words.size -> c.accent
                    focus -> c.ink
                    else -> c.ink2
                }
                withStyle(SpanStyle(color = color, fontWeight = if (i == shown - 1 && shown < m.words.size) FontWeight.SemiBold else null)) { append(w) }
                if (i < m.words.size - 1) append(' ')
            }
            if (m.cut) withStyle(SpanStyle(color = c.ink2)) { append(" —") }
        }
        Text(text, style = if (focus) MaterialTheme.typography.bodyLarge else MaterialTheme.typography.bodyMedium)
        if (m.cut) Text("You stepped in, so Sakhi paused", Modifier.padding(top = 6.dp), style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
    }
}

@Composable
private fun YouBubble(m: Message, focus: Boolean) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier.widthIn(max = 300.dp).clip(shape).background(c.accent2.copy(alpha = if (c.dark) 0.22f else 0.12f))
            .border(1.dp, c.accent2.copy(alpha = 0.35f), shape).padding(horizontal = 14.dp, vertical = 10.dp).animateContentSize(),
    ) {
        if (m.live) Row(verticalAlignment = Alignment.CenterVertically) {
            Text("LISTENING", style = MaterialTheme.typography.labelSmall.copy(color = c.accent2))
            Spacer(Modifier.size(6.dp)); Dots(c.accent2, small = true)
        }
        Text(m.text.ifEmpty { "…" }, style = MaterialTheme.typography.bodyMedium.copy(color = if (focus) c.ink else c.ink2))
    }
}

@Composable
private fun Dots(color: Color, small: Boolean = false) {
    var step by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { while (true) { delay(260); step = (step + 1) % 3 } }
    Row(horizontalArrangement = Arrangement.spacedBy(if (small) 3.dp else 5.dp), modifier = Modifier.semantics { contentDescription = "Sakhi is thinking" }) {
        repeat(3) { i -> Box(Modifier.size(if (small) 5.dp else 8.dp).clip(CircleShape).background(color.copy(alpha = if (i == step) 1f else 0.35f))) }
    }
}

@Composable
private fun TaskCard(s: CardState, reducedMotion: Boolean) {
    val c = Sakhi.colors
    // The band alternates English and Hindi, unless Hindi was asked for (then it stays Hindi).
    var hindi by remember(s.deal) { mutableStateOf(false) }
    LaunchedEffect(s.deal, s.hindiLocked) {
        if (s.hindiLocked) { hindi = true; return@LaunchedEffect }
        while (true) { delay(if (hindi) 7000 else 3500); hindi = !hindi }
    }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) {
        val w = maxWidth.coerceAtMost(360.dp)
        val shape = RoundedCornerShape(26.dp)
        Box(Modifier.size(w * 0.92f, 150.dp).rotate(-4f).clip(shape).background(c.back1))
        Box(Modifier.size(w * 0.95f, 150.dp).rotate(3f).clip(shape).background(c.back2))
        AnimatedContent(
            targetState = s,
            contentKey = { it.deal },
            transitionSpec = {
                if (reducedMotion) fadeIn(tween(120)) togetherWith fadeOut(tween(120))
                else (slideInVertically(tween(420)) { it / 3 } + fadeIn(tween(300))) togetherWith (slideOutVertically(tween(300)) { -it / 4 } + fadeOut(tween(220)))
            },
            label = "card",
        ) { cs ->
            Column(Modifier.width(w).clip(shape).background(c.surface).border(1.dp, c.line, shape)) {
                val band = cs.card.band
                Box(Modifier.fillMaxWidth().background(c.surface2).padding(horizontal = 16.dp, vertical = 9.dp)) {
                    val txt = when { cs.answered -> "हो गया · Answered"; hindi -> band?.hi.orEmpty(); else -> band?.en.orEmpty() }
                    AnimatedContent(txt, transitionSpec = { fadeIn(tween(240)) togetherWith fadeOut(tween(200)) }, label = "band") {
                        Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2, fontWeight = FontWeight.Medium))
                    }
                }
                Box(Modifier.fillMaxWidth().height(112.dp).padding(16.dp), contentAlignment = Alignment.Center) {
                    when (cs.card.look) {
                        "emoji" -> Text(cs.card.text, fontSize = 64.sp)
                        "word" -> Text(cs.card.text, style = MaterialTheme.typography.headlineLarge.copy(fontSize = if (cs.card.text.length > 14) 28.sp else 38.sp, letterSpacing = 2.sp), textAlign = TextAlign.Center)
                        else -> Text(cs.card.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium), textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}

@Composable
private fun Hint(state: UiState) {
    val c = Sakhi.colors
    val key = hintKey(state)
    AnimatedContent(key to state.learnerLanguage, transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(160)) }, label = "hint",
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp).semantics { liveRegion = LiveRegionMode.Polite }) { (k, lang) ->
        val (en, sub) = hintLines(k, lang)
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
            Text(en, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium), textAlign = TextAlign.Center)
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2, fontSize = 14.sp), textAlign = TextAlign.Center)
        }
    }
}

private val SKILLS = listOf("comprehension" to "Understanding", "vocabulary" to "English words", "grammar" to "Making sentences",
    "fluency" to "Speaking smoothly", "pronunciation" to "Saying words clearly", "coherence" to "Joining ideas")
private val SKILL_WORDS = listOf("Just starting", "Growing", "Steady", "Strong", "Shining")

@Composable
private fun ResultView(r: Result, onStartLearning: () -> Unit, onRestart: () -> Unit, modifier: Modifier) {
    val c = Sakhi.colors
    var how by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("YOUR LEVEL · LEVEL ${r.level} OF 4", style = MaterialTheme.typography.labelSmall.copy(color = c.accentDeep))
        Text(r.name, style = MaterialTheme.typography.headlineLarge)
        Text(r.blurb, style = MaterialTheme.typography.bodyLarge)
        r.hindi?.let { Text(it, style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2)) }
        Button(onStartLearning, Modifier.fillMaxWidth().height(54.dp), shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accentDeep, contentColor = c.onPrimary)) {
            Text("Start learning · सीखना शुरू करें", style = MaterialTheme.typography.labelLarge.copy(color = c.onPrimary))
        }
        TextButton(onRestart, Modifier.fillMaxWidth()) { Text("Take the test again", color = c.ink2) }
        if (r.doingWell.isNotEmpty() || r.practise.isNotEmpty()) ResultCard {
            if (r.doingWell.isNotEmpty()) { CardTitle("What went well"); r.doingWell.forEach { Bullet(it) } }
            if (r.practise.isNotEmpty()) { CardTitle("What we’ll practise next"); r.practise.forEach { Bullet(it) } }
        }
        val skills = SKILLS.mapNotNull { (k, label) -> r.dims[k]?.let { label to it.roundToInt().coerceIn(0, 4) } }
        if (skills.isNotEmpty()) ResultCard {
            CardTitle("Where you’re growing")
            skills.forEach { (label, n) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                        Text(SKILL_WORDS[n], style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        (1..4).forEach { i -> Box(Modifier.size(22.dp, 8.dp).clip(RoundedCornerShape(4.dp)).background(if (i <= n) c.accent else c.line)) }
                    }
                }
            }
        }
        OutlinedButton({ how = !how }) { Text(if (how) "Hide how we decided" else "How we decided", color = c.ink) }
        AnimatedVisibility(how) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (r.reasons.isEmpty()) Text("Your answers to all the questions, put together.", style = MaterialTheme.typography.bodyMedium)
                r.reasons.forEach { Bullet(it) }
                r.answers.filter { !it.transcript.isNullOrBlank() }.forEach {
                    Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(it.q.replace('_', ' ')) }; append(": ${it.transcript}") },
                        style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
                }
            }
        }
    }
}

@Composable private fun ResultCard(content: @Composable () -> Unit) {
    val c = Sakhi.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(c.surface).border(1.dp, c.line, RoundedCornerShape(20.dp)).padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
}
@Composable private fun CardTitle(t: String) = Text(t, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 4.dp))
@Composable private fun Bullet(t: String) = Row { Text("•  ", style = MaterialTheme.typography.bodyMedium); Text(t, style = MaterialTheme.typography.bodyMedium) }

@Composable
private fun MicScreen(onAllow: () -> Unit) {
    val c = Sakhi.colors
    var how by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.size(96.dp).clip(CircleShape).background(c.surface2), contentAlignment = Alignment.Center) {
            Box(Modifier.size(26.dp, 42.dp).clip(RoundedCornerShape(13.dp)).background(c.accent))
        }
        Text("I need microphone access to talk with you.", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Text("बात करने के लिए माइक की अनुमति चाहिए।", style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2), textAlign = TextAlign.Center)
        Text("I only listen while the orb says “Your turn”. Nothing is saved without asking you.", style = MaterialTheme.typography.bodySmall.copy(color = c.ink2), textAlign = TextAlign.Center)
        Button(onAllow, Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp), colors = ButtonDefaults.buttonColors(containerColor = c.accentDeep, contentColor = c.onPrimary)) { Text("Allow microphone") }
        OutlinedButton({ how = !how }, Modifier.fillMaxWidth()) { Text("How to turn it on", color = c.ink) }
        if (how) Text("Open Settings › Apps › Sakhi › Permissions, set Microphone to Allow, then come back and tap “Allow microphone”.",
            style = MaterialTheme.typography.bodySmall.copy(color = c.ink2), textAlign = TextAlign.Center)
    }
}
