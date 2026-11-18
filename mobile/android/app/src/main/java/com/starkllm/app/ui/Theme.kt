package com.starkllm.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
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

@Composable
fun StarkTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
