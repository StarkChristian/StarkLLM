package com.starkllm.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The colours of StarkLLM on the PC (frontend/src/index.css: --accent #4f46e5, --accent-bright #818cf8, dark #07060b)
private val Indigo = Color(0xFF4F46E5)
private val IndigoBright = Color(0xFF818CF8)
private val Night = Color(0xFF07060B)

private val Dark = darkColorScheme(
    primary = IndigoBright,
    onPrimary = Color(0xFF0B0A1A),
    primaryContainer = Color(0xFF2E2A7A),
    onPrimaryContainer = Color(0xFFE0E0FF),
    secondary = Color(0xFFB4B2E8),
    background = Night,
    onBackground = Color(0xFFE7E5F0),
    surface = Night,
    onSurface = Color(0xFFE7E5F0),
    surfaceVariant = Color(0xFF1D1B29),
    onSurfaceVariant = Color(0xFFC6C4D6),
    surfaceContainer = Color(0xFF14121E),
    surfaceContainerHigh = Color(0xFF1D1B29),
    outline = Color(0xFF6E6C80),
)

private val Light = lightColorScheme(
    primary = Indigo,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE0E0FF),
    onPrimaryContainer = Color(0xFF14105C),
    secondary = Color(0xFF5A5980),
    background = Color(0xFFFBFAFF),
    surface = Color(0xFFFBFAFF),
    surfaceVariant = Color(0xFFE6E4F2),
    surfaceContainer = Color(0xFFF1F0F8),
    surfaceContainerHigh = Color(0xFFEAE8F4),
)

/** Amber of the "check this quotation" note, as on the PC */
val Amber = Color(0xFFB45309)
val AmberBackground = Color(0x14F59E0B)

/** Success green of the "connected" dot */
val Connected = Color(0xFF22C55E)

// A compact type scale: phones are often set to larger text (the Flip5 of the test: 130 % and a larger display zoom),
// and Material's default sizes then look oversized. These sizes follow the system setting but start smaller.
private val Compact = Typography().let { d ->
    d.copy(
        headlineSmall = d.headlineSmall.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        titleLarge = d.titleLarge.copy(fontSize = 19.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        titleMedium = d.titleMedium.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
        titleSmall = d.titleSmall.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
        bodyLarge = d.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp, letterSpacing = 0.1.sp),
        bodyMedium = d.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp),
        bodySmall = d.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
        labelLarge = d.labelLarge.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
        labelMedium = d.labelMedium.copy(fontSize = 12.sp, lineHeight = 16.sp),
        labelSmall = d.labelSmall.copy(fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.6.sp),
    )
}

@Composable
fun StarkTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, typography = Compact, content = content)
}
