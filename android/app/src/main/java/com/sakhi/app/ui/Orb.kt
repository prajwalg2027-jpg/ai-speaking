package com.sakhi.app.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import com.sakhi.app.conversation.Phase
import com.sakhi.app.ui.theme.Sakhi
import kotlin.math.cos
import kotlin.math.sin

/**
 * The Molten orb (design 2e), drawn on a Canvas: an ember glass ball whose inner cloud swirls with the voice.
 * While the learner talks, a teal tide fills it from one side (the hand-off); thinking spins a soft ring.
 * The level is read inside the draw pass, so audio updates redraw without recomposing anything.
 */
@Composable
fun Orb(phase: Phase, level: () -> Float, reducedMotion: Boolean, modifier: Modifier = Modifier) {
    val c = Sakhi.colors
    val hand by animateFloatAsState(if (phase == Phase.LISTENING) 1f else 0f, spring(dampingRatio = 0.62f, stiffness = Spring.StiffnessVeryLow * 2), label = "hand")
    val think by animateFloatAsState(if (phase == Phase.THINKING) 1f else 0f, label = "think")
    val time = remember { mutableLongStateOf(0L) }
    val smooth = remember { mutableFloatStateOf(0f) }
    LaunchedEffect(reducedMotion) {
        if (reducedMotion) return@LaunchedEffect
        val start = withFrameNanos { it }
        while (true) withFrameNanos { time.longValue = it - start }
    }
    Canvas(modifier) {
        val t = time.longValue / 1e9f
        val target = when (phase) { Phase.IDLE -> 0f; Phase.THINKING -> 0.12f; else -> level() } * (if (reducedMotion) 0.2f else 1f)
        smooth.floatValue += (target - smooth.floatValue) * (if (target > smooth.floatValue) 0.38f else 0.14f)
        val l = smooth.floatValue
        val r = size.minDimension / 2 * 0.78f
        val center = Offset(size.width / 2, size.height / 2)
        val breathe = 1f + 0.015f * sin(t * 1.6f) + l * 0.07f
        // The glow behind the glass.
        drawCircle(Brush.radialGradient(listOf(c.accent.copy(alpha = 0.32f + l * 0.25f), Color.Transparent), center, r * (1.45f + l * 0.25f)), r * (1.45f + l * 0.25f), center)
        if (hand > 0.01f) drawCircle(Brush.radialGradient(listOf(c.accent2.copy(alpha = 0.30f * hand), Color.Transparent), center, r * 1.5f), r * 1.5f, center)
        scale(breathe, breathe * (1f - l * 0.03f), center) {
            val ball = Path().apply { addOval(androidx.compose.ui.geometry.Rect(center, r)) }
            clipPath(ball) {
                drawCircle(Brush.radialGradient(listOf(c.saffron, c.accent, c.accentDeep), center + Offset(-r * 0.35f, -r * 0.4f), r * 1.9f), r, center)
                // The cloud: soft puffs drifting with the voice (faster and wider when Sakhi speaks).
                val speed = when (phase) { Phase.SPEAKING -> 1.4f; Phase.THINKING -> 1.8f; Phase.LISTENING -> 0.7f; Phase.IDLE -> 0.45f }
                for (i in 0 until 7) {
                    val a = t * speed * (0.35f + i * 0.07f) + i * 1.7f
                    val d = r * (0.25f + 0.35f * ((i % 3) / 2f)) * (1f - hand * 0.6f) * (0.85f + l * 0.4f)
                    val p = center + Offset(cos(a) * d, sin(a * 1.13f) * d * 0.8f)
                    val col = if (i % 2 == 0) c.rust else c.saffron
                    drawCircle(Brush.radialGradient(listOf(col.copy(alpha = 0.55f), Color.Transparent), p, r * (0.45f + l * 0.2f)), r * (0.45f + l * 0.2f), p)
                }
                // The teal tide: the learner's turn.
                if (hand > 0.01f) {
                    val edge = center.x + r - 2 * r * hand.coerceAtMost(1.08f) * 0.86f + sin(t * 3f) * r * 0.04f * (1f + l * 3f)
                    val tide = Path().apply {
                        moveTo(edge, center.y - r * 1.1f)
                        val wob = r * (0.08f + l * 0.25f)
                        cubicTo(edge - wob * sin(t * 4f), center.y - r * 0.4f, edge + wob * cos(t * 3.3f), center.y + r * 0.4f, edge, center.y + r * 1.1f)
                        lineTo(center.x + r * 1.2f, center.y + r * 1.1f); lineTo(center.x + r * 1.2f, center.y - r * 1.1f); close()
                    }
                    drawPath(tide, Brush.linearGradient(listOf(c.accent2, c.accent2.copy(alpha = 0.85f)), Offset(edge, center.y), Offset(center.x + r, center.y)))
                }
                // Glass: the rim shading and the highlight.
                drawCircle(Brush.radialGradient(listOf(Color.Transparent, Color.Black.copy(alpha = if (c.dark) 0.28f else 0.16f)), center, r), r, center)
            }
            drawOval(Brush.radialGradient(listOf(Color.White.copy(alpha = 0.75f), Color.Transparent), center + Offset(-r * 0.32f, -r * 0.42f), r * 0.32f),
                topLeft = center + Offset(-r * 0.58f, -r * 0.62f), size = Size(r * 0.52f, r * 0.38f))
        }
        if (think > 0.01f) rotate(t * 140f, center) {
            drawArc(Brush.sweepGradient(listOf(Color.Transparent, c.accent.copy(alpha = 0.7f * think), Color.Transparent), center),
                0f, 300f, false, topLeft = center - Offset(r * 1.16f, r * 1.16f), size = Size(r * 2.32f, r * 2.32f), style = Stroke(r * 0.035f))
        }
    }
}
