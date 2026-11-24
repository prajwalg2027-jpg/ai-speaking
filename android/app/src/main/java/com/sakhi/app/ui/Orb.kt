package com.sakhi.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.dp
import com.sakhi.app.conversation.Phase
import com.sakhi.app.ui.theme.Sakhi
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign
import kotlin.math.sin
import kotlin.random.Random

/**
 * The Molten orb (design 2e), ported layer by layer from the web app: public/orb.js (the motion) and the .o-* rules
 * in public/styles.css (the look). An ember glass ball (swirling silk, folds, sheen, highlight) with a teal tint
 * cloud that clings to the glass wall and drifts with Sakhi's voice. On the learner's turn the cloud slides down
 * and pours into teal liquid that rises with their voice (the hand-off); when Sakhi takes the turn back, the
 * cloud reappears at a fresh spot on the wall. While she thinks, the glass stays still: the molten colours and the
 * cloud swirl faster inside it, and the ball breathes slowly with its glow (the shine never turns).
 *
 * Sizes are the design's pixels on its 200 px orb, scaled to this one. CSS blurs are drawn as soft gradients
 * (they work on every Android version), and the soft-light/overlay blends as plain see-through white.
 * The per-frame state lives in [OrbSim], so audio updates redraw without recomposing anything.
 */
@Composable
fun Orb(phase: Phase, level: () -> Float, reducedMotion: Boolean, modifier: Modifier = Modifier) {
    val c = Sakhi.colors
    val sim = remember { OrbSim() }
    val frame = remember { mutableLongStateOf(0L) }
    val phaseNow by rememberUpdatedState(phase)
    val levelNow by rememberUpdatedState(level)
    LaunchedEffect(reducedMotion) {
        if (reducedMotion) return@LaunchedEffect
        var last = 0L
        while (true) withFrameNanos { now ->
            val dt = if (last == 0L) 0.016f else ((now - last) / 1e9f).coerceIn(0f, 0.05f)
            last = now
            sim.step(dt, phaseNow, levelNow())
            frame.longValue = now
        }
    }
    Canvas(modifier) {
        frame.longValue // redraw on every frame of the loop above
        if (reducedMotion) sim.still(phase, level())
        val p = OrbPaint(c.accent, c.accentDeep, c.accent2)
        drawOrb(sim, p, animated = !reducedMotion, breathing = phase == Phase.IDLE && !reducedMotion)
    }
}

/** The theme colours the orb uses (the rest are the design's fixed tints). */
private class OrbPaint(val accent: Color, val accentDeep: Color, val accent2: Color)

// The design's fixed oklch() tints, in sRGB.
private val Amber = Color(0xFFE99D6E)      // oklch(0.76 0.11 52): glow and the fourth silk pool
private val Ember = Color(0xFFC25335)      // oklch(0.58 0.15 36): the third silk pool
private val Puff0 = Color(0xFF25C2C2)      // oklch(0.74 0.12 195): the cloud's core
private val Puff1 = Color(0xFF00969F)      // oklch(0.60 0.13 200)
private val Puff2 = Color(0xFF008590)      // oklch(0.55 0.12 203): the cloud's edge
private val WispTint = Color(0xFFBFF0EC)   // oklch(0.92 0.05 190)
private val WaveTint = Color(0xFF76C7CC)   // oklch(0.78 0.08 200): the lighter crest of the liquid

/** The cloud's puffs: left, top, size (% of the cloud's region) and which fluid cell moves it. */
private val PUFFS = listOf(
    floatArrayOf(4f, 6f, 50f, 0f), floatArrayOf(30f, 0f, 54f, 6f), floatArrayOf(52f, 8f, 46f, 7f), floatArrayOf(18f, 24f, 48f, 8f),
    floatArrayOf(42f, 26f, 44f, 9f), floatArrayOf(64f, 22f, 34f, 3f), floatArrayOf(0f, 30f, 32f, 12f),
)

/** One CSS keyframe: at [at] (0..1) the shape is moved by ([x], [y]) % of its own size and scaled by [s]. */
private class Key(val at: Float, val x: Float, val y: Float, val s: Float)

private val FLOW1 = listOf(Key(0f, -8f, -6f, 1f), Key(0.33f, 14f, 4f, 1.15f), Key(0.66f, -2f, 16f, 0.9f), Key(1f, -8f, -6f, 1f))
private val FLOW2 = listOf(Key(0f, 10f, 12f, 1.05f), Key(0.4f, -14f, -4f, 0.88f), Key(0.75f, 6f, -14f, 1.12f), Key(1f, 10f, 12f, 1.05f))
private val FLOW3 = listOf(Key(0f, 0f, 14f, 0.95f), Key(0.5f, -10f, -12f, 1.18f), Key(1f, 0f, 14f, 0.95f))

/** The silk's pools: left, top, size (% of the silk), colour, flow, period (s), delay (s). */
private class Pool(val l: Float, val t: Float, val s: Float, val color: (OrbPaint) -> Color, val flow: List<Key>, val period: Float, val delay: Float)

private val POOLS = listOf(
    Pool(-12f, -8f, 72f, { it.accent }, FLOW1, 4.2f, 0f),
    Pool(34f, 34f, 66f, { it.accentDeep }, FLOW2, 5.39f, 1.3f),
    Pool(2f, 40f, 56f, { Ember }, FLOW3, 6.58f, 2.6f),
    Pool(40f, -6f, 44f, { Amber }, FLOW1, 7.77f, 3.9f),
)

/** CSS keyframes with ease-in-out between them. */
private fun keyframe(keys: List<Key>, time: Float, period: Float): Key {
    val f = ((time / period) % 1f + 1f) % 1f
    val i = keys.indexOfLast { it.at <= f }.coerceAtMost(keys.size - 2)
    val a = keys[i]; val b = keys[i + 1]
    val u = ((f - a.at) / (b.at - a.at)).coerceIn(0f, 1f)
    val e = u * u * (3 - 2 * u)
    return Key(f, a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e, a.s + (b.s - a.s) * e)
}

private fun DrawScope.drawOrb(o: OrbSim, p: OrbPaint, animated: Boolean, breathing: Boolean) {
    val u = size.minDimension / 200f // one design pixel
    val center = Offset(size.width / 2, size.height / 2)
    val t = if (animated) o.time else 0f
    val breathe = if (breathing) 1f + 0.02f * (1 - cos(t / 4.2f * 2 * PI.toFloat())) else 1f

    scale(breathe, breathe, center) {
        // Behind the glass: the ember glow. It grows with the voice, and brightens with each breath while she thinks.
        val breath = if (animated) o.breath else 0.5f
        val gA = 76f * u * (0.95f + o.lvl * 0.35f + o.think * breath * 0.1f)
        softConic(
            center + Offset(0f, 12f * u), gA, 32f * u, -90f,
            listOf(0f to p.accent, 0.33f to p.accentDeep, 0.66f to Amber, 1f to p.accent),
            (0.35f + o.lvl * 0.55f) * (1 - o.think * 0.45f) + o.think * breath * 0.25f,
        )

        // The glass ball: pulses with the level and the hand-off, breathes while thinking, and its outline morphs.
        // It never turns, so its shine stays where the light is.
        val sc = 0.94f + o.lvl * 0.3f + o.hpulse * 0.05f + o.think * (breath * 0.08f - 0.02f)
        scale(sc, sc, center) {
            val b = 164f * u // the ball's box (inset 9%)
            val tl = center - Offset(b / 2, b / 2)
            val ball = blobPath(center, b / 2, if (animated) t else null)
            clipPath(ball) {
                drawRect(p.accentDeep, tl, Size(b, b))
                silk(o, p, tl, b, center, t, animated, u)
                folds(o, b, center, t, animated)
                sheen(center, b, t, animated)
                rotate(o.cang, center) { cloud(o, tl, b); wisp(o, tl, b) }
                liquid(o, p, tl, b, t, animated)
                highlight(center, tl, b, u)
            }
            drawPath(ball, Color.White.copy(alpha = 0.25f), style = Stroke(1.dp.toPx()))
        }
    }
}

/** The ball's outline: a circle whose radius wobbles like the design's border-radius morph (3.2 s). */
private fun blobPath(center: Offset, r: Float, time: Float?): Path = Path().apply {
    val n = 72
    val ph = (time ?: 0f) / 3.2f * 2 * PI.toFloat()
    for (i in 0..n) {
        val a = i * 2 * PI.toFloat() / n
        val k = if (time == null) 1f else 1f + 0.03f * sin(2 * a + ph) + 0.02f * sin(3 * a - ph * 1.3f + 1f)
        val pt = center + Offset(cos(a) * r * k, sin(a) * r * k)
        if (i == 0) moveTo(pt.x, pt.y) else lineTo(pt.x, pt.y)
    }
    close()
}

/** Four soft pools of ember colour drifting on their own, the whole silk turning faster while she speaks. */
private fun DrawScope.silk(o: OrbSim, p: OrbPaint, tl: Offset, b: Float, center: Offset, t: Float, animated: Boolean, u: Float) {
    val w = b * 1.4f
    val stl = tl - Offset(b * 0.2f, b * 0.2f)
    rotate(o.turn, center) {
        for (pool in POOLS) {
            val d = pool.s / 100 * w
            val k = if (animated) keyframe(pool.flow, t + pool.delay, pool.period) else Key(0f, 0f, 0f, 1f)
            val pc = stl + Offset((pool.l + pool.s / 2) / 100 * w + k.x / 100 * d, (pool.t + pool.s / 2) / 100 * w + k.y / 100 * d)
            softDisk(pc, d / 2 * k.s, 16f * u, pool.color(p))
        }
    }
}

/** Light folds in the molten glass, slowly turning (8 s), brighter with the voice. */
private fun DrawScope.folds(o: OrbSim, b: Float, center: Offset, t: Float, animated: Boolean) {
    val box = b * 1.6f
    val f = if (animated) ((t / 8f) % 1f) else 0f
    val ty = (if (f < 0.5f) -6f + 24f * f else 18f - 24f * f) / 100 * box
    val strength = 0.13f * (0.55f + o.lvl * 0.45f)
    val dir = Offset(0.906f, 0.423f) // 115deg
    val period = box * (0.906f + 0.423f) * 0.27f
    val clear = Color.White.copy(alpha = 0f)
    withTransform({ rotate(f * 360f, center); translate(0f, ty) }) {
        drawRect(
            Brush.linearGradient(0f to clear, 0.333f to clear, 0.481f to Color.White.copy(alpha = strength), 0.667f to clear, 1f to clear,
                start = center, end = center + dir * period, tileMode = TileMode.Repeated),
            center - Offset(box / 2, box / 2), Size(box, box),
        )
    }
}

/**
 * Two soft highlights sweeping round the glass (9 s, against the silk). Faded towards the middle, where the design's
 * blur hides the point the bands meet.
 */
private fun DrawScope.sheen(center: Offset, b: Float, t: Float, animated: Boolean) {
    val r = b * 0.46f
    val clear = Color.White.copy(alpha = 0f)
    val a = 0.5f
    val turn = if (animated) -(t / 9f % 1f) * 360f else 0f
    drawIntoCanvas { it.saveLayer(Rect(center, r), Paint()) }
    rotate(turn - 90f, center) {
        drawCircle(
            Brush.sweepGradient(0f to clear, 0.14f to clear, 0.22f to Color.White.copy(alpha = 0.45f * a), 0.34f to clear, 0.56f to clear,
                0.66f to Color.White.copy(alpha = 0.28f * a), 0.78f to clear, 1f to clear, center = center),
            r * 0.97f, center,
        )
    }
    drawCircle(
        Brush.radialGradient(0f to Color.Black.copy(alpha = 0f), 0.5f to Color.Black, 0.8f to Color.Black, 1f to Color.Black.copy(alpha = 0f),
            center = center, radius = r),
        r, center, blendMode = BlendMode.DstIn,
    )
    drawIntoCanvas { it.restore() }
}

/** The teal tint cloud on the wall: seven puffs pushed about by the fluid, swelling while Sakhi speaks. */
private fun DrawScope.cloud(o: OrbSim, tl: Offset, b: Float) {
    val alpha = (0.6f + o.spk * 0.35f + o.hand * 0.3f) * (1 - ((o.hand - 0.6f) * 2.5f).coerceIn(0f, 1f))
    if (alpha <= 0.01f) return
    val rw = b * 1.18f; val rh = b * 0.84f
    val rtl = tl + Offset(-b * 0.09f, -b * 0.22f)
    val origin = Offset(tl.x + b / 2, tl.y - b * 0.22f)
    val sx = (0.82f + o.spk * 0.3f) * o.rx2 * (1 + o.hand * 0.55f)
    val sy = (0.78f + o.spk * 0.34f) * o.ry2 * (1 - o.hand * 0.4f)
    val move = 0.016f * (1 - o.hand * 0.7f)
    val swell = 0.85f + o.spk * 0.3f
    scale(sx, sy, origin) {
        for (pf in PUFFS) {
            val i = pf[3].toInt()
            val w = pf[2] / 100 * rw; val h = pf[2] / 100 * rh
            val pc = rtl + Offset(pf[0] / 100 * rw + w / 2 + o.cx[i] * move * w, pf[1] / 100 * rh + h / 2 + o.cy[i] * move * h)
            val r = w * 0.48f
            scale(o.cs[i] * swell, o.ct[i] * swell * min(1f, (h / 2) / (w * 0.454f)), pc) {
                drawCircle(
                    Brush.radialGradient(0f to Puff0.copy(alpha = 0.95f * alpha), 0.43f to Puff1.copy(alpha = 0.7f * alpha),
                        0.78f to Puff2.copy(alpha = 0.28f * alpha), 1f to Puff2.copy(alpha = 0f), center = pc, radius = r),
                    r, pc,
                )
            }
        }
    }
}

/** A pale wisp along the wall above the cloud; it fades as the turn passes to the learner. */
private fun DrawScope.wisp(o: OrbSim, tl: Offset, b: Float) {
    val alpha = 0.55f * 0.5f * (1 - o.hand)
    if (alpha <= 0.01f) return
    val w = b * 0.6f; val h = b * 0.22f
    val pc = tl + Offset(b / 2 + o.cx[13] * 0.02f * w, b * 0.13f)
    val k = 0.7f + o.spk * 0.5f
    scale(k, k * h / w, pc) {
        drawCircle(Brush.radialGradient(0f to WispTint.copy(alpha = alpha), 1f to WispTint.copy(alpha = 0f), center = pc, radius = w / 2), w / 2, pc)
    }
}

/** The learner's turn: teal liquid with two turning crests, rising with their voice. */
private fun DrawScope.liquid(o: OrbSim, p: OrbPaint, tl: Offset, b: Float, t: Float, animated: Boolean) {
    val alpha = ((o.hand - 0.4f) * 2.2f).coerceIn(0f, 1f)
    if (alpha <= 0.01f) return
    val dy = (1 - o.hand) * 0.34f * b
    val side = b * 1.7f
    // Reduced motion: no swaying voice level, so the liquid rests at a calm height instead.
    val lift = if (animated) o.lvl * 0.5f * o.hand else 0.25f * o.hand
    val deep = lerp(p.accent2, Color.Black, 0.3f)
    for ((start, spin, isCrest) in listOf(Triple(0.64f, 7f, true), Triple(0.68f, 4.6f, false))) {
        val top = tl + Offset(-b * 0.35f, dy + (start - lift) * side)
        val box = Rect(top, Size(side, side))
        val shape = Path().apply { addRoundRect(RoundRect(box, CornerRadius(side * 0.42f))) }
        rotate(if (animated) (t / spin % 1f) * 360f else 0f, box.center) {
            if (isCrest) drawPath(shape, WaveTint, alpha = 0.8f * alpha)
            else drawPath(shape, Brush.verticalGradient(listOf(p.accent2, deep), box.top, box.bottom), alpha = 0.9f * alpha)
        }
    }
}

/** The glass: a bright highlight top left, a faint one bottom right, light along the top rim and shade below. */
private fun DrawScope.highlight(center: Offset, tl: Offset, b: Float, u: Float) {
    val r = b / 2
    drawCircle(Brush.radialGradient(0.72f to Color.Black.copy(alpha = 0f), 1f to Color.Black.copy(alpha = 0.16f),
        center = center - Offset(0f, 9f * u), radius = r * 1.04f), r * 1.2f, center)
    drawCircle(Brush.radialGradient(0.8f to Color.White.copy(alpha = 0f), 1f to Color.White.copy(alpha = 0.45f),
        center = center + Offset(0f, 5f * u), radius = r * 1.02f), r * 1.2f, center)
    val hc = tl + Offset(b * 0.32f, b * 0.22f)
    scale(1f, 0.22f / 0.34f, hc) {
        drawCircle(Brush.radialGradient(0f to Color.White.copy(alpha = 0.85f), 0.7f to Color.White.copy(alpha = 0f), 1f to Color.White.copy(alpha = 0f),
            center = hc, radius = b * 0.34f), b * 0.34f, hc)
    }
    val lc = tl + Offset(b * 0.7f, b * 0.88f)
    drawCircle(Brush.radialGradient(0f to Color.White.copy(alpha = 0.18f), 1f to Color.White.copy(alpha = 0f), center = lc, radius = b * 0.337f), b * 0.337f, lc)
}

// ---- soft shapes (the design's CSS blurs) ----------------------------------------------------------------------

/** How much of a disk of radius [r], blurred by [sigma], covers a point [d] from its centre. */
private fun coverage(d: Float, r: Float, sigma: Float): Float =
    if (sigma < 0.01f) (if (d <= r) 1f else 0f) else 0.5f * (1 - erf((d - r) / (sigma * 1.4142f)))

private fun erf(x: Float): Float {
    val a = abs(x)
    val t = 1f / (1f + 0.3275911f * a)
    val y = 1f - (((((1.061405429f * t - 1.453152027f) * t) + 1.421413741f) * t - 0.284496736f) * t + 0.254829592f) * t * exp(-a * a)
    return sign(x) * y
}

private fun softStops(r: Float, sigma: Float, color: Color, alpha: Float): Pair<Float, Array<Pair<Float, Color>>> {
    val outer = r + 2.2f * sigma
    val n = 10
    // The last stop is fully clear, so the gradient's own edge never shows as a ring.
    return outer to Array(n + 1) { i -> val d = outer * i / n; i.toFloat() / n to color.copy(alpha = if (i == n) 0f else color.alpha * alpha * coverage(d, r, sigma)) }
}

/** A blurred disk. */
private fun DrawScope.softDisk(center: Offset, r: Float, sigma: Float, color: Color, alpha: Float = 1f, blend: BlendMode = BlendMode.SrcOver) {
    if (alpha <= 0.004f || r <= 0f) return
    val (outer, stops) = softStops(r, sigma, color, alpha)
    drawCircle(Brush.radialGradient(*stops, center = center, radius = outer), outer, center, blendMode = blend)
}

/** Draws [content] and keeps only what falls inside a blurred disk. */
private fun DrawScope.masked(center: Offset, r: Float, sigma: Float, alpha: Float, content: DrawScope.() -> Unit) {
    if (alpha <= 0.004f) return
    val outer = r + 2.2f * sigma
    drawIntoCanvas { it.saveLayer(Rect(center, outer), Paint().apply { this.alpha = alpha }) }
    content()
    softDisk(center, r, sigma, Color.Black, blend = BlendMode.DstIn)
    drawIntoCanvas { it.restore() }
}

/** A blurred disk filled with a conic gradient (CSS conic-gradient + blur), turned by [degrees]. */
private fun DrawScope.softConic(center: Offset, r: Float, sigma: Float, degrees: Float, stops: List<Pair<Float, Color>>, alpha: Float) =
    masked(center, r, sigma, alpha.coerceIn(0f, 1f)) {
        // A little inside the mask's edge, so no antialiased rim of it is left uncovered.
        rotate(degrees, center) { drawCircle(Brush.sweepGradient(*stops.toTypedArray(), center = center), (r + 2.2f * sigma) * 0.97f, center) }
    }

// ---- the motion (public/orb.js tick() and stepFluid()) ----------------------------------------------------------

/** Everything that changes from frame to frame. Not Compose state: the draw pass reads it on each frame. */
internal class OrbSim(private val rnd: Random = Random.Default) {
    var time = 0f; private set
    var lvl = 0f; private set
    var hand = 0f; private set
    var cang = 0f; private set
    var spk = 0f; private set
    var hpulse = 0f; private set
    var turn = 0f; private set
    var think = 0f; private set
    /** 0..1, one slow breath every 1.8 s; the ball uses it while thinking. */
    var breath = 0f; private set
    var rx2 = 1f; private set
    var ry2 = 1f; private set
    val cx = FloatArray(14); val cy = FloatArray(14)
    val cs = FloatArray(14) { 1f }; val ct = FloatArray(14) { 1f }

    private class Cell(var x: Float, var y: Float) { var vx = 0f; var vy = 0f; var s = 0f; var vs = 0f; var a = 0f; var va = 0f }
    private val cells = Array(14) { Cell((rnd.nextFloat() * 2 - 1) * 6, (rnd.nextFloat() * 2 - 1) * 6) }
    private var tsp = 16f
    private var rX = 0f; private var rVx = 0f; private var rY = 0f; private var rVy = 0f
    private var angA = rnd.nextFloat() * 360f; private var angV = 10f
    private var handRaw = 0f; private var hv = 0f; private var prev = 0f; private var wasListening = false

    private fun g() = (rnd.nextFloat() + rnd.nextFloat() + rnd.nextFloat() - 1.5f) * 2f
    private fun cl(v: Float, m: Float) = v.coerceIn(-m, m)

    /** One animation frame of [dt] seconds; [target] is the audio level (Sakhi's voice, or the mic on the learner's turn). */
    fun step(dt: Float, phase: Phase, target: Float) {
        time += dt
        val tgt = when (phase) { Phase.THINKING -> 0.12f; Phase.IDLE -> 0f; else -> target.coerceIn(0f, 1f) }
        lvl += (tgt - lvl) * (if (tgt > lvl) 0.38f else 0.14f)
        val speed = when (phase) { Phase.IDLE -> 16f; Phase.SPEAKING -> 51f; Phase.LISTENING -> 22f; Phase.THINKING -> 170f }
        tsp += (speed - tsp) * min(1f, dt * 2.5f)
        turn = (turn + tsp * dt) % 360f
        think += ((if (phase == Phase.THINKING) 1f else 0f) - think) * min(1f, dt * 5f)
        breath = 0.5f - 0.5f * cos(time / 1.8f * 2 * PI.toFloat())
        fluid(dt, phase)
    }

    private fun fluid(dt: Float, phase: Phase) {
        val l = lvl
        val listening = phase == Phase.LISTENING
        val onset = max(0f, l - prev); prev = l
        val energy = (0.35f + l * 1.4f) * (1 - handRaw * 0.6f)
        val kick = if (onset > 0.06f) onset * 260f * (1 - handRaw) else 0f
        cells.forEachIndexed { i, c ->
            if (kick != 0f) { c.vx += g() * kick; c.vy += g() * kick; c.vs += g() * kick * 0.012f; c.va += g() * kick * 0.012f }
            c.vx += (-5 * c.x - 2.2f * c.vx + g() * 170 * energy) * dt; c.x += c.vx * dt
            c.vy += (-5 * c.y - 2.2f * c.vy + g() * 170 * energy) * dt; c.y += c.vy * dt
            c.vs += (-9 * c.s - 3 * c.vs + g() * 2.6f * energy) * dt; c.s += c.vs * dt
            c.va += (-9 * c.a - 3 * c.va + g() * 2.6f * energy) * dt; c.a += c.va * dt
            cx[i] = cl(c.x, 26f); cy[i] = cl(c.y, 26f); cs[i] = 1 + cl(c.s, 0.32f); ct[i] = 1 + cl(c.a, 0.32f)
        }
        rVx += (-7 * rX - 3 * rVx + g() * 1.8f * energy) * dt; rX += rVx * dt
        rVy += (-7 * rY - 3 * rVy + g() * 1.8f * energy) * dt; rY += rVy * dt
        rx2 = 1 + cl(rX, 0.22f); ry2 = 1 + cl(rY, 0.22f)
        // The hand-off: a slightly under-damped spring, so the liquid overshoots and settles. On hand-back the
        // cloud travels to a fresh spot on the wall (never the bottom).
        if (wasListening && !listening) {
            val side = if (rnd.nextFloat() < 0.5f) -1 else 1
            angA = 180f + side * (115f + rnd.nextFloat() * 110f); angV = side * 14f
        }
        wasListening = listening
        val k = if (listening) 38f else 24f
        val damp = if (listening) 8.5f else 7.2f
        hv += (((if (listening) 1f else 0f) - handRaw) * k - hv * damp) * dt; handRaw += hv * dt
        val h = handRaw.coerceIn(0f, 1.08f)
        if (h < 0.5f) {
            angV += (g() * 46 * energy - 0.7f * angV + (if (kick != 0f) g() * kick * 0.6f else 0f)) * dt
            angV = cl(angV, 70f); angA = (angA + (angV + think * 150f) * dt) % 360f // the cloud swirls round while she thinks
        }
        val d = ((180f - angA) % 360f + 540f) % 360f - 180f
        val e = min(1f, h)
        val ease = e * e * (3 - 2 * e)
        cang = angA + d * ease
        if (listening && h > 0.97f) { angA = cang; angV = 0f }
        spk += ((if (phase == Phase.SPEAKING) l else 0f) - spk) * 0.3f
        hand = h
        hpulse = max(0f, sin(min(1f, h) * PI.toFloat()))
    }

    /** Reduced motion: a still picture of the phase. */
    fun still(phase: Phase, target: Float) {
        val tgt = when (phase) { Phase.THINKING -> 0.12f; Phase.IDLE -> 0f; else -> target.coerceIn(0f, 1f) }
        lvl = tgt * 0.2f
        hand = if (phase == Phase.LISTENING) 1f else 0f
        cang = if (phase == Phase.LISTENING) 180f else 0f
        spk = if (phase == Phase.SPEAKING) 0.3f else 0f
        think = if (phase == Phase.THINKING) 1f else 0f
        hpulse = 0f; turn = 0f; breath = 0.5f; rx2 = 1f; ry2 = 1f
        cx.fill(0f); cy.fill(0f); cs.fill(1f); ct.fill(1f)
    }
}
