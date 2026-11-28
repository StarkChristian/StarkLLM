package com.starkllm.app.ui

import android.app.Activity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker

/**
 * How the phone is held. Tabletop: a foldable (Galaxy Z Flip) half folded with the fold across the screen ("flex mode");
 * the upper half is for reading, the lower half for the hands. hingeTop/hingeBottom are window pixels.
 */
data class Posture(val tabletop: Boolean = false, val hingeTop: Int = 0, val hingeBottom: Int = 0)

val LocalPosture = compositionLocalOf { Posture() }

/** The fold of the window, from Jetpack WindowManager (nothing is sent anywhere) */
@Composable
fun rememberPosture(activity: Activity): Posture {
    val layouts = remember(activity) { WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity) }
    val info by layouts.collectAsState(initial = null)
    val fold = info?.displayFeatures?.filterIsInstance<FoldingFeature>()?.firstOrNull() ?: return Posture()
    return if (fold.state == FoldingFeature.State.HALF_OPENED && fold.orientation == FoldingFeature.Orientation.HORIZONTAL) {
        Posture(tabletop = true, hingeTop = fold.bounds.top, hingeBottom = fold.bounds.bottom)
    } else Posture()
}

/**
 * A small window: the Galaxy Z Flip's cover screen (Flex Window, about 3.4 inches), or a phone held sideways. The
 * screens then leave out what is only decoration (the subtitle under the greeting, Lucy).
 */
@Composable
fun isCompactHeight(): Boolean = LocalConfiguration.current.screenHeightDp < 520

/**
 * In tabletop posture [upper] fills the screen down to the fold and [lower] the part below it; otherwise [upper] takes
 * the room left by [lower], as on a flat phone.
 */
@Composable
fun FoldAware(modifier: Modifier, upper: @Composable ColumnScope.() -> Unit, lower: @Composable ColumnScope.() -> Unit) {
    val posture = LocalPosture.current
    if (!posture.tabletop) {
        Column(modifier) {
            Column(Modifier.weight(1f)) { upper() }
            lower()
        }
        return
    }
    var top by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    Column(modifier.onGloballyPositioned { top = it.positionInWindow().y.toInt() }) {
        val upperHeight = with(density) { (posture.hingeTop - top).coerceAtLeast(0).toDp() }
        val hinge = with(density) { (posture.hingeBottom - posture.hingeTop).coerceAtLeast(0).toDp() }
        Column(Modifier.height(upperHeight)) { upper() }
        Spacer(Modifier.height(hinge + 4.dp))
        Column(Modifier.weight(1f)) { lower() }
    }
}
