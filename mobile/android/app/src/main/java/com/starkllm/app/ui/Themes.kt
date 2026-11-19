package com.starkllm.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/** A drawn background of some themes, as on the PC (frontend/src/index.css) */
enum class Pattern { DOODLE, FLOWERS, MATRIX, STARS }

/**
 * The themes of StarkLLM on the PC (frontend/src/utils/themes.js): the same ids, names and colours, so the phone looks
 * like the PC it belongs to. "system" follows the phone's dark or light mode with Midnight Indigo / Daylight Minimal.
 */
data class AppTheme(
    val id: String,
    val bg: Color,
    val card: Color,
    val accent: Color,
    val bright: Color,
    val gradient: List<Color>,
    val light: Boolean = false,
    val pattern: Pattern? = null,
)

val THEMES = listOf(
    AppTheme("dark", Color(0xFF05070A), Color(0xFF121622), Color(0xFF4F46E5), Color(0xFF818CF8), listOf(Color(0xFF6366F1), Color(0xFF8B5CF6))),
    AppTheme("pink", Color(0xFF0A040B), Color(0xFF220F28), Color(0xFFF43F5E), Color(0xFFFB7185), listOf(Color(0xFFEC4899), Color(0xFFF43F5E))),
    AppTheme("black", Color(0xFF000000), Color(0xFF101010), Color(0xFF0284C7), Color(0xFF38BDF8), listOf(Color(0xFF0284C7), Color(0xFF38BDF8))),
    AppTheme("glass", Color(0xFF070B16), Color(0xFF162036), Color(0xFF8B5CF6), Color(0xFFA78BFA), listOf(Color(0xFFA855F7), Color(0xFF38BDF8))),
    AppTheme("emerald", Color(0xFF030C08), Color(0xFF0D281E), Color(0xFF10B981), Color(0xFF34D399), listOf(Color(0xFF10B981), Color(0xFF06B6D4))),
    AppTheme("amber", Color(0xFF0B0602), Color(0xFF26190B), Color(0xFFF59E0B), Color(0xFFFBBF24), listOf(Color(0xFFF59E0B), Color(0xFFEA580C))),
    AppTheme("nord", Color(0xFF060F18), Color(0xFF152C43), Color(0xFF0891B2), Color(0xFF22D3EE), listOf(Color(0xFF06B6D4), Color(0xFF3B82F6))),
    AppTheme("light", Color(0xFFF0F2F8), Color(0xFFFFFFFF), Color(0xFF4F46E5), Color(0xFF6366F1), listOf(Color(0xFF6366F1), Color(0xFF8B5CF6)), light = true),
    AppTheme("doodle", Color(0xFFEFE6DC), Color(0xFFFFFDF9), Color(0xFF0F766E), Color(0xFF0D9488), listOf(Color(0xFF0D9488), Color(0xFF14B8A6)), light = true, pattern = Pattern.DOODLE),
    AppTheme("doodle-night", Color(0xFF0B141A), Color(0xFF1F2C33), Color(0xFF14B8A6), Color(0xFF2DD4BF), listOf(Color(0xFF14B8A6), Color(0xFF06B6D4)), pattern = Pattern.DOODLE),
    AppTheme("flowers", Color(0xFFFDF2F6), Color(0xFFFFFFFF), Color(0xFFDB2777), Color(0xFFEC4899), listOf(Color(0xFFEC4899), Color(0xFFF59E0B)), light = true, pattern = Pattern.FLOWERS),
    AppTheme("matrix", Color(0xFF000A03), Color(0xFF02140A), Color(0xFF16A34A), Color(0xFF22C55E), listOf(Color(0xFF16A34A), Color(0xFF4ADE80)), pattern = Pattern.MATRIX),
    AppTheme("stars", Color(0xFF0A0F24), Color(0xFF161E44), Color(0xFFF59E0B), Color(0xFFFBBF24), listOf(Color(0xFF6366F1), Color(0xFFF59E0B)), pattern = Pattern.STARS),
)

const val SYSTEM_THEME = "system"

fun themeFor(id: String, systemDark: Boolean): AppTheme =
    THEMES.firstOrNull { it.id == id } ?: THEMES.first { it.id == if (systemDark) "dark" else "light" }

/** The theme in use, for the parts Material's colours do not cover (gradients, the pattern) */
val LocalStarkTheme = staticCompositionLocalOf { THEMES.first() }

/** Material colours from a StarkLLM theme */
fun colorSchemeOf(t: AppTheme): ColorScheme {
    val onBg = if (t.light) Color(0xFF15131F) else Color(0xFFE9E7F2)
    val muted = if (t.light) Color(0xFF5B5970) else Color(0xFFB9B6CB)
    val raise = { amount: Float -> lerp(t.card, if (t.light) Color(0xFF000000) else Color(0xFFFFFFFF), amount) }
    val primary = if (t.light) t.accent else t.bright
    val container = if (t.light) lerp(t.accent, Color.White, 0.84f) else lerp(t.accent, t.bg, 0.55f)
    val onContainer = if (t.light) lerp(t.accent, Color.Black, 0.55f) else lerp(t.bright, Color.White, 0.55f)
    return if (t.light) {
        lightColorScheme(
            primary = primary, onPrimary = Color.White, primaryContainer = container, onPrimaryContainer = onContainer,
            secondary = t.bright, background = t.bg, onBackground = onBg, surface = t.bg, onSurface = onBg,
            surfaceVariant = raise(0.06f), onSurfaceVariant = muted, surfaceContainer = t.card, surfaceContainerHigh = raise(0.05f),
            surfaceContainerHighest = raise(0.09f), outline = lerp(muted, t.bg, 0.4f), outlineVariant = raise(0.12f),
        )
    } else {
        darkColorScheme(
            primary = primary, onPrimary = Color(0xFF0B0A12), primaryContainer = container, onPrimaryContainer = onContainer,
            secondary = t.accent, background = t.bg, onBackground = onBg, surface = t.bg, onSurface = onBg,
            surfaceVariant = raise(0.08f), onSurfaceVariant = muted, surfaceContainer = t.card, surfaceContainerHigh = raise(0.07f),
            surfaceContainerHighest = raise(0.12f), outline = lerp(muted, t.bg, 0.45f), outlineVariant = raise(0.16f),
        )
    }
}

fun gradientOf(t: AppTheme) = Brush.linearGradient(t.gradient)

/** The theme's background: its colour and, for the pattern themes, the drawing (seeded, so it does not change) */
@Composable
fun ThemeBackground(t: AppTheme, modifier: Modifier = Modifier.fillMaxSize()) {
    val seed = remember(t.id) { t.id.hashCode() }
    Canvas(modifier) {
        drawRect(t.bg)
        when (t.pattern) {
            Pattern.STARS -> stars(seed)
            Pattern.MATRIX -> matrix(seed, t)
            Pattern.DOODLE -> doodles(seed, t)
            Pattern.FLOWERS -> flowers(seed)
            null -> if (!t.light) glow(t)
        }
    }
}

// a soft light of the accent colour in a corner, as on the PC's dark themes
private fun DrawScope.glow(t: AppTheme) {
    drawRect(Brush.radialGradient(listOf(t.accent.copy(alpha = 0.10f), Color.Transparent), center = Offset(size.width, 0f), radius = size.maxDimension * 0.75f))
}

private fun DrawScope.stars(seed: Int) {
    val r = Random(seed)
    val n = (size.width * size.height / (34.dp.toPx() * 34.dp.toPx())).toInt().coerceIn(40, 400)
    repeat(n) {
        val c = Offset(r.nextFloat() * size.width, r.nextFloat() * size.height)
        val big = r.nextFloat() < 0.08f
        drawCircle(Color(0xFFE0E7FF).copy(alpha = 0.25f + r.nextFloat() * 0.5f), radius = if (big) 1.6.dp.toPx() else (0.5f + r.nextFloat()) * 0.9.dp.toPx(), center = c)
        if (big) {
            val s = 4.dp.toPx()
            val col = Color(0xFFFBBF24).copy(alpha = 0.35f)
            drawLine(col, c.copy(x = c.x - s), c.copy(x = c.x + s), 0.8.dp.toPx())
            drawLine(col, c.copy(y = c.y - s), c.copy(y = c.y + s), 0.8.dp.toPx())
        }
    }
}

private fun DrawScope.matrix(seed: Int, t: AppTheme) {
    val r = Random(seed)
    val step = 16.dp.toPx()
    val paint = android.graphics.Paint().apply {
        isAntiAlias = true
        typeface = android.graphics.Typeface.MONOSPACE
        textSize = 11.dp.toPx()
    }
    val glyphs = "01アイウエオカキクケコサシスセソ7Z∑λ"
    var x = step / 2
    while (x < size.width) {
        val length = r.nextInt(6, 22)
        val start = r.nextFloat() * size.height
        for (i in 0 until length) {
            val y = start + i * step
            if (y > size.height) break
            val fade = (i + 1f) / length
            paint.color = android.graphics.Color.argb((14 + 50 * fade).toInt(), 34, 197, 94)
            drawContext.canvas.nativeCanvas.drawText(glyphs[r.nextInt(glyphs.length)].toString(), x, y, paint)
        }
        x += step
    }
    drawRect(Brush.verticalGradient(listOf(Color.Transparent, t.bg.copy(alpha = 0.6f))))
}

private fun DrawScope.doodles(seed: Int, t: AppTheme) {
    val r = Random(seed)
    val ink = (if (t.light) Color(0xFF8A7560) else Color(0xFF8FB7C3)).copy(alpha = if (t.light) 0.16f else 0.10f)
    val cell = 64.dp.toPx()
    val stroke = Stroke(1.4.dp.toPx())
    var y = cell / 2
    var row = 0
    while (y < size.height + cell) {
        var x = if (row % 2 == 0) cell / 2 else cell
        while (x < size.width + cell) {
            val c = Offset(x + r.nextFloat() * 14f, y + r.nextFloat() * 14f)
            val s = 9.dp.toPx()
            rotate(r.nextFloat() * 50f - 25f, c) {
                when (r.nextInt(5)) {
                    0 -> drawPath(heart(c, s), ink, style = stroke)
                    1 -> drawPath(star(c, s, 5), ink, style = stroke)
                    2 -> { // a letter
                        drawRect(ink, Offset(c.x - s, c.y - s * 0.7f), androidx.compose.ui.geometry.Size(s * 2, s * 1.4f), style = stroke)
                        drawPath(Path().apply { moveTo(c.x - s, c.y - s * 0.7f); lineTo(c.x, c.y + s * 0.1f); lineTo(c.x + s, c.y - s * 0.7f) }, ink, style = stroke)
                    }
                    3 -> { // a little doll
                        drawCircle(ink, s * 0.4f, Offset(c.x, c.y - s * 0.6f), style = stroke)
                        drawPath(Path().apply { moveTo(c.x, c.y - s * 0.2f); lineTo(c.x - s * 0.6f, c.y + s * 0.8f); lineTo(c.x + s * 0.6f, c.y + s * 0.8f); close() }, ink, style = stroke)
                    }
                    else -> drawCircle(ink, s * 0.5f, c, style = stroke)
                }
            }
            x += cell
        }
        y += cell * 0.86f
        row++
    }
}

private fun DrawScope.flowers(seed: Int) {
    val r = Random(seed)
    val colors = listOf(Color(0xFFF9A8D4), Color(0xFFC4B5FD), Color(0xFFFDBA74), Color(0xFFF0ABFC))
    val cell = 58.dp.toPx()
    var y = cell / 2
    while (y < size.height + cell) {
        var x = cell / 2 + r.nextFloat() * cell / 2
        while (x < size.width + cell) {
            val c = Offset(x, y + r.nextFloat() * cell * 0.4f)
            val petal = (3.5f + r.nextFloat() * 2.5f) * density
            val col = colors[r.nextInt(colors.size)].copy(alpha = 0.32f)
            for (k in 0 until 5) {
                val a = 2 * PI * k / 5
                drawCircle(col, petal, Offset(c.x + cos(a).toFloat() * petal * 1.2f, c.y + sin(a).toFloat() * petal * 1.2f))
            }
            drawCircle(Color(0xFFFDE68A).copy(alpha = 0.55f), petal * 0.7f, c)
            x += cell * (0.8f + r.nextFloat() * 0.6f)
        }
        y += cell * 0.8f
    }
}

private fun heart(c: Offset, s: Float) = Path().apply {
    moveTo(c.x, c.y + s * 0.8f)
    cubicTo(c.x - s * 1.4f, c.y - s * 0.2f, c.x - s * 0.6f, c.y - s * 1.2f, c.x, c.y - s * 0.4f)
    cubicTo(c.x + s * 0.6f, c.y - s * 1.2f, c.x + s * 1.4f, c.y - s * 0.2f, c.x, c.y + s * 0.8f)
    close()
}

private fun star(c: Offset, s: Float, points: Int) = Path().apply {
    for (i in 0 until points * 2) {
        val radius = if (i % 2 == 0) s else s * 0.45f
        val a = PI * i / points - PI / 2
        val p = Offset(c.x + cos(a).toFloat() * radius, c.y + sin(a).toFloat() * radius)
        if (i == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y)
    }
    close()
}
