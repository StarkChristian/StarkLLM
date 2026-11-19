package com.starkllm.app.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

/**
 * Lucy, the StarkLLM robot of the PC (frontend/src/assets/lucy/lucy-markup.html), drawn with the same shapes:
 * blue body, yellow hair, red shoes. She breathes, blinks and, when waving, waves her right arm.
 */
@Composable
fun Lucy(modifier: Modifier = Modifier, waving: Boolean = false, description: String? = null) {
    val motion = rememberInfiniteTransition(label = "lucy")
    val bob by motion.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, easing = LinearEasing), RepeatMode.Reverse), label = "bob")
    val blink by motion.animateFloat(
        1f, 1f,
        infiniteRepeatable(keyframes {
            durationMillis = 4200
            1f at 3900
            0.1f at 4000
            1f at 4100
        }),
        label = "blink",
    )
    val wave by motion.animateFloat(-1f, 1f, infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse), label = "wave")
    Canvas(
        modifier.aspectRatio(1080f / 1050f).semantics { if (description != null) contentDescription = description },
    ) {
        val k = size.width / 1080f
        scale(k, k, pivot = Offset.Zero) {
            translate(-90f, 50f) {
                lucy(bob = bob, blink = blink, wave = if (waving) wave else 0f)
            }
        }
    }
}

private val Body = Brush.linearGradient(listOf(Color(0xFF4390D0), Color(0xFF3A84C4), Color(0xFF3178B6)), Offset(262f, 258f), Offset(1006f, 806f))
private val Limb = Brush.verticalGradient(listOf(Color(0xFF3F8CCC), Color(0xFF2F74B0)))
private val Hair = Color(0xFFF6B800)
private val ShoeRed = Color(0xFFE2492C)
private val ShoeYellow = Color(0xFFF6C313)
private val Eye = Color(0xFF231E1B)
private val Mouth = Color(0xFFD6363D)

private fun DrawScope.box(x: Float, y: Float, w: Float, h: Float, r: Float, brush: Brush) =
    drawRoundRect(brush, Offset(x, y), Size(w, h), CornerRadius(r, r))

private fun DrawScope.box(x: Float, y: Float, w: Float, h: Float, r: Float, color: Color) =
    drawRoundRect(color, Offset(x, y), Size(w, h), CornerRadius(r, r))

private fun DrawScope.lucy(bob: Float, blink: Float, wave: Float) {
    // shadow on the floor, smaller while she is up
    drawOval(Color(0xFF0B1B2B).copy(alpha = 0.22f), Offset(290f + bob * 20f, 935f), Size(700f - bob * 40f, 40f))
    // legs and shoes stay on the floor
    for (x in listOf(502f, 685f)) {
        box(x, 780f, 70f, 130f, 26f, Limb)
        box(x - 16f, 890f, 102f, 50f, 22f, ShoeRed)
        box(x - 20f, 918f, 110f, 30f, 15f, ShoeYellow)
        box(x - 26f, 942f, 122f, 16f, 8f, Color.White)
    }
    translate(0f, -bob * 14f) {
        // arms: the right one waves from the shoulder
        box(108f, 532f, 174f, 66f, 28f, Limb)
        rotate(wave * -28f, Offset(996f, 565f)) { box(986f, 532f, 164f, 68f, 28f, Limb) }
        // hair
        val hair = Stroke(10f, cap = StrokeCap.Round)
        drawPath(Path().apply { moveTo(508f, 262f); cubicTo(508f, 170f, 486f, 110f, 448f, 62f) }, Hair, style = hair)
        drawPath(Path().apply { moveTo(633f, 262f); cubicTo(633f, 170f, 640f, 90f, 660f, 30f) }, Hair, style = hair)
        drawPath(Path().apply { moveTo(757f, 262f); cubicTo(757f, 190f, 770f, 130f, 808f, 80f) }, Hair, style = hair)
        // body (the head) with a soft shine on top
        box(262f, 258f, 744f, 548f, 52f, Body)
        drawRoundRect(Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.16f), Color.Transparent), 258f, 480f), Offset(262f, 258f), Size(744f, 548f), CornerRadius(52f, 52f))
        // eyes
        for (cx in listOf(467f, 798f)) {
            drawCircle(Color(0xFF1C4A78).copy(alpha = 0.28f), 75f, Offset(cx, 481f))
            drawOval(Eye, Offset(cx - 68f, 478f - 68f * blink), Size(136f, 136f * blink))
            if (blink > 0.5f) drawCircle(Color.White.copy(alpha = 0.8f), 14f, Offset(cx - 22f, 452f))
        }
        // smile
        drawPath(Path().apply { moveTo(551f, 628f); cubicTo(575f, 690f, 690f, 692f, 716f, 622f) }, Mouth, style = Stroke(30f, cap = StrokeCap.Round))
    }
}
