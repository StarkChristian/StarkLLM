package com.starkllm.app.ui

import kotlin.math.pow

/**
 * Text on a theme's gradient (the question bubble, the send button, the intro's button) with the contrast WCAG AA asks
 * for normal text: 4.5:1 against every colour of the gradient. Colours are ARGB ints, so this runs without Android.
 */
object Contrast {
    const val WHITE = 0xFFFFFFFF.toInt()
    /** the dark text of the light themes */
    const val INK = 0xFF15131F.toInt()
    private const val BLACK = 0xFF000000.toInt()
    const val AA = 4.5

    /** relative luminance (WCAG 2) */
    fun luminance(argb: Int): Double {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF) / 255.0
            return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    fun ratio(a: Int, b: Int): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }

    /** a moved toward b by t (0..1), opaque */
    fun mix(a: Int, b: Int, t: Double): Int {
        fun ch(shift: Int) = (((a shr shift) and 0xFF) * (1 - t) + ((b shr shift) and 0xFF) * t).toInt().coerceIn(0, 255)
        return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    /**
     * White on the darker gradients (as on the PC), the dark ink on the light ones: white stays where it reaches 3:1 on
     * every colour (a small darkening then reaches 4.5:1 without changing the look), else the ink.
     */
    fun textOn(stops: List<Int>): Int = if (stops.all { ratio(WHITE, it) >= 3.0 }) WHITE else INK

    /** the gradient's colours, each moved just enough (darker under white, lighter under the ink) for 4.5:1 */
    fun readableStops(stops: List<Int>, text: Int = textOn(stops)): List<Int> = stops.map { stop ->
        val toward = if (luminance(text) > 0.5) BLACK else WHITE
        var step = 0
        var c = stop
        while (ratio(text, c) < AA && step < 50) {
            step++
            c = mix(stop, toward, step * 0.02)
        }
        c
    }
}
