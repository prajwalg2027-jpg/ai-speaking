package com.sakhi.app.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sakhi.app.R

/** The design handoff's tokens (public/styles.css hex fallbacks), light and dark. */
@Immutable
data class SakhiColors(
    val bg: Color, val glow: Color, val surface: Color, val surface2: Color, val ink: Color, val ink2: Color,
    val line: Color, val line2: Color, val accent: Color, val accentDeep: Color, val accent2: Color,
    val saffron: Color, val rust: Color, val hot: Color, val back1: Color, val back2: Color, val onPrimary: Color,
    val dark: Boolean,
)

val LightTokens = SakhiColors(
    bg = Color(0xFFFCF0E9), glow = Color(0xFFFFD8C6), surface = Color(0xFFFFFBF6), surface2 = Color(0xFFF7E3D9),
    ink = Color(0xFF2F1810), ink2 = Color(0xFF694E45), line = Color(0xFFE2CCC0), line2 = Color(0xFFD1B8AA),
    accent = Color(0xFFD87248), accentDeep = Color(0xFF993C25), accent2 = Color(0xFF00828D), saffron = Color(0xFFEFB062),
    rust = Color(0xFFD15D4D), hot = Color(0xFF993C25), back1 = Color(0xFFEBD2C3), back2 = Color(0xFFF4E0D4),
    onPrimary = Color.White, dark = false,
)

val DarkTokens = SakhiColors(
    bg = Color(0xFF05151A), glow = Color(0xFF002D34), surface = Color(0xFF0B2227), surface2 = Color(0xFF122D34),
    ink = Color(0xFFF6ECE5), ink2 = Color(0xFFC1B5AB), line = Color(0xFF30474C), line2 = Color(0xFF40575D),
    accent = Color(0xFFED845B), accentDeep = Color(0xFFB44D34), accent2 = Color(0xFF48B7BD), saffron = Color(0xFFEFB062),
    rust = Color(0xFFD15D4D), hot = Color(0xFFFDA578), back1 = Color(0xFF142A30), back2 = Color(0xFF1A353B),
    onPrimary = Color(0xFF01151B), dark = true,
)

val Anek = FontFamily(
    Font(R.font.anek_regular, FontWeight.Normal),
    Font(R.font.anek_medium, FontWeight.Medium),
    Font(R.font.anek_semibold, FontWeight.SemiBold),
    Font(R.font.anek_bold, FontWeight.Bold),
)

val LocalSakhi = staticCompositionLocalOf { LightTokens }

object Sakhi {
    val colors: SakhiColors @Composable get() = LocalSakhi.current
}

@Composable
fun SakhiTheme(dark: Boolean = isSystemInDarkTheme(), wideFrame: Boolean = false, content: @Composable () -> Unit) {
    val t = if (dark) DarkTokens else LightTokens
    val scheme = if (dark) darkColorScheme(primary = t.accentDeep, onPrimary = t.ink, background = t.bg, surface = t.surface, onSurface = t.ink, onBackground = t.ink)
    else lightColorScheme(primary = t.accentDeep, onPrimary = t.onPrimary, background = t.bg, surface = t.surface, onSurface = t.ink, onBackground = t.ink)
    // No colour in the text styles: text takes its container's content colour (ink on the page, white on buttons).
    val base = TextStyle(fontFamily = Anek)
    val type = MaterialTheme.typography.let { m ->
        m.copy(
            bodyLarge = base.copy(fontSize = 19.sp, lineHeight = 28.sp),
            bodyMedium = base.copy(fontSize = 16.sp, lineHeight = 23.sp),
            bodySmall = base.copy(fontSize = 13.sp, lineHeight = 18.sp),
            titleLarge = base.copy(fontSize = 26.sp, fontWeight = FontWeight.SemiBold),
            headlineLarge = base.copy(fontSize = 40.sp, fontWeight = FontWeight.Bold, lineHeight = 44.sp),
            labelLarge = base.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            labelSmall = base.copy(fontSize = 12.sp, fontWeight = FontWeight.Medium, letterSpacing = 1.2.sp),
        )
    }
    CompositionLocalProvider(LocalSakhi provides t) {
        MaterialTheme(colorScheme = scheme, typography = type) {
            CompositionLocalProvider(LocalContentColor provides t.ink) { if (wideFrame) WideScreenFrame(t, content) else content() }
        }
    }
}

/**
 * Tablets, foldables and landscape: the app runs at any size and orientation (Android 16 ignores
 * portrait locks on large screens), so the screens keep a phone-like reading width, centred on the
 * page's own background instead of stretching across a wide window.
 */
@Composable
private fun WideScreenFrame(t: SakhiColors, content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(t.glow, t.bg), endY = 900f)),
        contentAlignment = Alignment.TopCenter,
    ) {
        Box(Modifier.fillMaxHeight().widthIn(max = MAX_CONTENT_WIDTH).fillMaxWidth()) { content() }
    }
}

private val MAX_CONTENT_WIDTH = 640.dp
