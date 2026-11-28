package com.starkllm.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import android.app.Activity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.graphics.Color

// The dark tile of the StarkLLM mark (launcher icon), the same in every theme
internal val Night = Color(0xFF07060B)

/** Amber of the "check this quotation" note, as on the PC */
val Amber = Color(0xFFB45309)
/** the same amber, lighter, for "due this week" on the dark themes' cards (Amber itself is too dark there) */
val AmberOnDark = Color(0xFFFBBF24)
val AmberBackground = Color(0x14F59E0B)

/** Success green of the "connected" dot */
val Connected = Color(0xFF22C55E)

// A compact type scale: phones are often set to larger text (the Flip5 of the test: 130 % and a larger display zoom),
// and Material's default sizes then look oversized. These sizes follow the system setting but start smaller.
private val Compact = Typography().let { d ->
    d.copy(
        headlineSmall = d.headlineSmall.copy(fontSize = 21.sp, lineHeight = 27.sp, fontWeight = FontWeight.SemiBold),
        titleLarge = d.titleLarge.copy(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
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

/** Larger system text is followed by 40 %: 130 % becomes 112 %, 200 % becomes 140 % (owner's review, Galaxy Z Flip5). */
fun dampedFontScale(system: Float): Float = if (system > 1f) 1f + (system - 1f) * 0.4f else system

/** A larger display zoom ("Bildschirmzoom") is followed by half; a smaller one as it is. stable: the device's own density. */
fun dampedDensity(current: Float, stable: Float): Float = if (stable > 0f && current > stable) stable + (current - stable) / 2f else current

@Composable
fun StarkTheme(themeId: String = SYSTEM_THEME, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    val theme = themeFor(themeId, isSystemInDarkTheme())
    CompositionLocalProvider(
        LocalDensity provides Density(
            dampedDensity(density.density, android.util.DisplayMetrics.DENSITY_DEVICE_STABLE / 160f),
            dampedFontScale(density.fontScale),
        ),
        LocalStarkTheme provides theme,
    ) {
        // dark status bar icons on the light themes, light ones on the dark themes
        val view = LocalView.current
        if (!view.isInEditMode) {
            SideEffect {
                (view.context as? Activity)?.window?.let { w ->
                    WindowCompat.getInsetsController(w, view).apply {
                        isAppearanceLightStatusBars = theme.light
                        isAppearanceLightNavigationBars = theme.light
                    }
                }
            }
        }
        MaterialTheme(colorScheme = colorSchemeOf(theme), typography = Compact, content = content)
    }
}
