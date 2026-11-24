package com.sakhi.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.sakhi.app.conversation.SayPhase
import com.sakhi.app.conversation.UiState
import com.sakhi.app.conversation.resultText
import com.sakhi.app.net.AnswerInsight
import com.sakhi.app.net.DiffPart
import com.sakhi.app.net.Insights
import com.sakhi.app.net.Result
import com.sakhi.app.net.SayBack
import com.sakhi.app.ui.theme.Sakhi
import kotlin.math.roundToInt

/** What the result screen can do. [hear]: Sakhi says a sentence; [say]: record the learner saying it back. */
data class ResultActions(
    val startLearning: () -> Unit = {},
    val restart: () -> Unit = {},
    val report: (String) -> Unit = {},
    val hear: (String) -> Unit = {},
    val say: (String) -> Unit = {},
)

private val SKILLS = listOf("comprehension" to "Understanding", "vocabulary" to "English words", "grammar" to "Making sentences",
    "fluency" to "Speaking smoothly", "pronunciation" to "Saying words clearly", "coherence" to "Joining ideas")
private val SKILL_WORDS = listOf("Just starting", "Growing", "Steady", "Strong", "Shining")
private val LEVEL_NAMES = mapOf(1 to "Beginner", 2 to "Basic", 3 to "Good", 4 to "Very good")

/**
 * The result: the level, then what the learner can learn from their own answers (server/placement/insights.js):
 * their best sentence, each answer said the right way (or one level up), with "hear it" and "say it back",
 * their level said four ways, one habit, a tip for Indian English, and what they said, counted. The feedback
 * arrives a moment after the level; until then a line says Sakhi is writing it.
 */
@Composable
fun ResultView(state: UiState, a: ResultActions, modifier: Modifier) {
    val r = state.result ?: return
    val c = Sakhi.colors
    val ins = state.insights
    Column(modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            LevelHeader(r)
            if (state.insightsLoading) Box(Modifier.fillMaxWidth()) {
                ResultCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = c.accent, strokeWidth = 2.dp)
                        Text("Sakhi is writing feedback on your answers…", style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2))
                    }
                }
            }
            if (ins != null) InsightCards(ins, r.level, state, a)
            if (r.doingWell.isNotEmpty() || r.practise.isNotEmpty()) ResultCard {
                if (r.doingWell.isNotEmpty()) { CardTitle("What went well"); r.doingWell.forEach { Bullet(it) } }
                if (r.practise.isNotEmpty()) { CardTitle("What we’ll practise next"); r.practise.forEach { Bullet(it) } }
            }
            Skills(r)
            HowWeDecided(r)
            TextButton(a.restart, Modifier.fillMaxWidth()) { Text("Take the test again", color = c.ink2) }
            TextButton({ a.report(resultText(r)) }, Modifier.fillMaxWidth()) {
                Text("Report a problem with this feedback", color = c.ink2, style = MaterialTheme.typography.bodySmall)
            }
        }
        Button(a.startLearning, Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp).height(54.dp), shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accentDeep, contentColor = c.onPrimary)) {
            Text(if (ins?.answers?.isNotEmpty() == true) "Practise with Sakhi · सीखना शुरू करें" else "Start learning · सीखना शुरू करें",
                style = MaterialTheme.typography.labelLarge.copy(color = c.onPrimary))
        }
    }
}

@Composable
private fun LevelHeader(r: Result) {
    val c = Sakhi.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("YOUR LEVEL · LEVEL ${r.level} OF 4", style = MaterialTheme.typography.labelSmall.copy(color = c.accentDeep))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(r.name, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.weight(1f))
            Row(Modifier.semantics { contentDescription = "Level ${r.level} of 4" }, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                (1..4).forEach { i -> Box(Modifier.size(26.dp, 8.dp).clip(RoundedCornerShape(4.dp)).background(if (i <= r.level) c.accent else c.line)) }
            }
        }
        Text(r.blurb, style = MaterialTheme.typography.bodyLarge)
        r.hindi?.let { Text(it, style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2)) }
    }
}

@Composable
private fun InsightCards(ins: Insights, level: Int, state: UiState, a: ResultActions) {
    ins.best?.let { b ->
        ResultCard {
            Eyebrow("Your best moment")
            Text("“${b.quote}”", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold))
            if (b.tags.isNotEmpty()) Tags(b.tags)
            b.why?.let { Small(it) }
        }
    }
    if (ins.answers.isNotEmpty()) Answers(ins.answers, level, state, a)
    ins.ladder?.let { l ->
        ResultCard {
            Eyebrow("How each level would say it")
            l.rungs.sortedByDescending { it.level }.forEach { rung -> Rung(rung.level, rung.text, rung.level == l.you) }
        }
    }
    ins.habit?.let { h ->
        ResultCard {
            Eyebrow("One habit to work on")
            Text(h.name, style = MaterialTheme.typography.titleMedium)
            h.examples.forEach { e ->
                Diff(e.diff, showRemoved = true)
                SayRow(e.better, state, a)
            }
            Small(h.rule)
        }
    }
    ins.tip?.let { t ->
        ResultCard {
            Eyebrow("A tip for you")
            Text(t.title, style = MaterialTheme.typography.titleMedium)
            Text(struck(t.said), style = MaterialTheme.typography.bodyMedium)
            Text(highlighted(t.better), style = MaterialTheme.typography.bodyMedium)
            Small(t.rule)
            t.hindi?.let { Small(it) }
            SayRow(t.better, state, a)
        }
    }
    ins.counts?.takeIf { it.answers > 0 }?.let { n ->
        ResultCard {
            Eyebrow("What you said, counted")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Stat(n.englishWords.toString(), "English words spoken", Modifier.weight(1f))
                Stat(n.longestAnswer.toString(), "words in your longest answer", Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Stat(n.joiningWords.size.toString(), if (n.joiningWords.isEmpty()) "joining words (and, because…)" else "joining words: ${n.joiningWords.joinToString(", ")}", Modifier.weight(1f))
                Stat(n.hindiWords.toString(), "Hindi words mixed in", Modifier.weight(1f))
            }
        }
    }
}

/** Each answer, one at a time: "Fix" shows it said the right way; "Next level" the same idea one level up. */
@Composable
private fun Answers(list: List<AnswerInsight>, level: Int, state: UiState, a: ResultActions) {
    val c = Sakhi.colors
    var at by rememberSaveable { mutableIntStateOf(0) }
    var up by rememberSaveable { mutableStateOf(false) }
    val i = at.coerceIn(0, list.lastIndex)
    val ans = list[i]
    val hasUp = list.any { it.up != null }
    ResultCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Eyebrow(if (up) "Your answers, one level up" else "Your answers, polished", Modifier.weight(1f))
            if (list.size > 1) Text("${i + 1} of ${list.size}", style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
        }
        if (hasUp) Toggle(up) { up = it }
        if (ans.question.isNotBlank()) Small(ans.question)
        Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (!up) {
                Label("You said")
                Diff(if (ans.same) listOf(DiffPart(ans.said)) else ans.diff, showRemoved = true)
                if (ans.same) Text("✓ Already well said!", style = MaterialTheme.typography.bodyMedium.copy(color = c.accent2, fontWeight = FontWeight.SemiBold))
                else {
                    Label("Sakhi would say")
                    Diff(ans.diff, showRemoved = false)
                    ans.why?.let { Small(it) }
                }
                SayRow(ans.better, state, a)
            } else if (ans.up != null) {
                Label("You (level $level)")
                Text(ans.better, style = MaterialTheme.typography.bodyMedium.copy(color = c.ink2))
                Label(if (level >= 4) "A confident speaker" else "Level ${level + 1} (${LEVEL_NAMES[level + 1]})")
                Diff(ans.upDiff, showRemoved = false)
                if (ans.upAdds.isNotEmpty()) Tags(ans.upAdds)
                SayRow(ans.up, state, a)
            } else Small("This answer is already strong for the next level.")
        }
        if (list.size > 1) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton({ at = (i - 1).coerceAtLeast(0) }, enabled = i > 0) { Text("‹ Back") }
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.Center) {
                list.indices.forEach { k ->
                    Box(Modifier.padding(3.dp).size(7.dp).clip(CircleShape).background(if (k == i) c.accent else c.line).clickable(role = Role.Button) { at = k })
                }
            }
            TextButton({ at = (i + 1).coerceAtMost(list.lastIndex) }, enabled = i < list.lastIndex) { Text("Next ›") }
        }
    }
}

/** Hear Sakhi say it, then say it back; how it went appears under it. */
@Composable
private fun SayRow(text: String, state: UiState, a: ResultActions) {
    val c = Sakhi.colors
    val sb = state.sayBack
    val mine = sb.text == text
    val playing = mine && sb.phase == SayPhase.PLAYING
    val recording = mine && sb.phase == SayPhase.RECORDING
    val checking = mine && sb.phase == SayPhase.CHECKING
    Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton({ a.hear(text) }, shape = RoundedCornerShape(12.dp)) { Text(if (playing) "■ Stop" else "▶ Hear it", color = c.accent2) }
        Button({ a.say(text) }, enabled = !checking, shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(containerColor = if (recording) c.rust else c.accent, contentColor = c.onPrimary)) {
            Text(when { recording -> "■ Done"; checking -> "Checking…"; else -> "● Say it" }, color = c.onPrimary)
        }
    }
    if (recording) Small("Say the sentence, then tap Done.")
    if (mine && sb.error != null && sb.phase == SayPhase.IDLE) Small(sb.error)
    sb.results[text]?.let { SayResult(it) }
}

@Composable
private fun SayResult(r: SayBack) {
    val c = Sakhi.colors
    val pct = if (r.total > 0) r.matched.toDouble() / r.total else 0.0
    Text(buildAnnotatedString {
        r.words.forEachIndexed { k, w ->
            if (k > 0) append(" ")
            if (w.ok) withStyle(SpanStyle(color = c.ink)) { append(w.t) }
            else withStyle(SpanStyle(color = c.rust, textDecoration = TextDecoration.Underline)) { append(w.t) }
        }
    }, style = MaterialTheme.typography.bodyMedium)
    val (mark, line) = when {
        pct >= 0.9 -> "✓" to "Excellent! ${r.matched} of ${r.total} words."
        pct >= 0.6 -> "~" to "Nearly there: ${r.matched} of ${r.total} words. Try the underlined words again."
        else -> "↻" to "${r.matched} of ${r.total} words. Hear it once more, then try again."
    }
    Text("$mark $line", style = MaterialTheme.typography.bodySmall.copy(color = if (pct >= 0.9) c.accent2 else c.ink2, fontWeight = FontWeight.SemiBold))
}

@Composable
private fun Diff(parts: List<DiffPart>, showRemoved: Boolean) {
    val c = Sakhi.colors
    Text(buildAnnotatedString {
        parts.filter { if (showRemoved) it.k != "add" else it.k != "del" }.forEachIndexed { k, p ->
            if (k > 0) append(" ")
            when (p.k) {
                "del" -> withStyle(SpanStyle(color = c.rust, textDecoration = TextDecoration.LineThrough)) { append(p.t) }
                "add" -> withStyle(SpanStyle(background = c.saffron.copy(alpha = if (c.dark) 0.35f else 0.45f), fontWeight = FontWeight.SemiBold)) { append(p.t) }
                else -> append(p.t)
            }
        }
    }, style = MaterialTheme.typography.bodyLarge)
}

@Composable private fun struck(t: String): AnnotatedString {
    val c = Sakhi.colors
    return buildAnnotatedString { withStyle(SpanStyle(color = c.rust, textDecoration = TextDecoration.LineThrough)) { append(t) } }
}
@Composable private fun highlighted(t: String): AnnotatedString {
    val c = Sakhi.colors
    return buildAnnotatedString { withStyle(SpanStyle(background = c.saffron.copy(alpha = if (c.dark) 0.35f else 0.45f), fontWeight = FontWeight.SemiBold)) { append(t) } }
}

@Composable
private fun Toggle(up: Boolean, onChange: (Boolean) -> Unit) {
    val c = Sakhi.colors
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(50)).background(c.surface2).padding(3.dp)) {
        listOf(false to "Fix", true to "Next level").forEach { (v, label) ->
            Box(Modifier.weight(1f).clip(RoundedCornerShape(50)).background(if (up == v) c.surface else Color.Transparent)
                .clickable(role = Role.Tab) { onChange(v) }.padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
                Text(label, style = MaterialTheme.typography.bodySmall.copy(color = if (up == v) c.ink else c.ink2, fontWeight = if (up == v) FontWeight.SemiBold else null))
            }
        }
    }
}

@Composable
private fun Rung(level: Int, text: String, you: Boolean) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(if (you) c.surface2 else c.surface).border(1.dp, if (you) c.accent else c.line, shape).padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("$level", style = MaterialTheme.typography.titleMedium.copy(color = if (you) c.accent else c.ink2, fontWeight = FontWeight.Bold), modifier = Modifier.width(16.dp))
        Text(buildAnnotatedString {
            if (you) withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("You are here. ") }
            append("“$text”")
        }, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun Stat(value: String, label: String, modifier: Modifier) {
    val c = Sakhi.colors
    val shape = RoundedCornerShape(14.dp)
    Column(modifier.clip(shape).background(c.surface2).padding(10.dp)) {
        Text(value, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold))
        Text(label, style = MaterialTheme.typography.bodySmall.copy(color = c.ink2))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Tags(tags: List<String>) {
    val c = Sakhi.colors
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        tags.forEach { Text(it, style = MaterialTheme.typography.bodySmall.copy(color = c.accentDeep), modifier = Modifier.clip(RoundedCornerShape(50)).background(c.surface2).padding(horizontal = 9.dp, vertical = 2.dp)) }
    }
}

@Composable
private fun Skills(r: Result) {
    val c = Sakhi.colors
    val skills = SKILLS.mapNotNull { (k, label) -> r.dims[k]?.let { label to it.roundToInt().coerceIn(0, 4) } }
    if (skills.isEmpty()) return
    ResultCard {
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
}

@Composable
private fun HowWeDecided(r: Result) {
    val c = Sakhi.colors
    var how by rememberSaveable { mutableStateOf(false) }
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

@Composable private fun ResultCard(content: @Composable () -> Unit) {
    val c = Sakhi.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(c.surface).border(1.dp, c.line, RoundedCornerShape(20.dp)).padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}
@Composable private fun Eyebrow(t: String, modifier: Modifier = Modifier) =
    Text(t.uppercase(), style = MaterialTheme.typography.labelSmall.copy(color = Sakhi.colors.accent2, fontWeight = FontWeight.SemiBold), modifier = modifier)
@Composable private fun Label(t: String) = Text(t, style = MaterialTheme.typography.labelMedium.copy(color = Sakhi.colors.ink2))
@Composable private fun Small(t: String) = Text(t, style = MaterialTheme.typography.bodySmall.copy(color = Sakhi.colors.ink2))
@Composable private fun CardTitle(t: String) = Text(t, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 4.dp))
@Composable private fun Bullet(t: String) = Row { Text("•  ", style = MaterialTheme.typography.bodyMedium); Text(t, style = MaterialTheme.typography.bodyMedium) }
