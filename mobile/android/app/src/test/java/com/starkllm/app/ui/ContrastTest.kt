package com.starkllm.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The gradients of the themes (ui/Themes.kt) with the text colour the app puts on them */
class ContrastTest {
    private val gradients = mapOf(
        "dark" to listOf(0xFF6366F1, 0xFF8B5CF6), "pink" to listOf(0xFFEC4899, 0xFFF43F5E), "black" to listOf(0xFF0284C7, 0xFF38BDF8),
        "glass" to listOf(0xFFA855F7, 0xFF38BDF8), "emerald" to listOf(0xFF10B981, 0xFF06B6D4), "amber" to listOf(0xFFF59E0B, 0xFFEA580C),
        "nord" to listOf(0xFF06B6D4, 0xFF3B82F6), "doodle" to listOf(0xFF0D9488, 0xFF14B8A6), "doodle-night" to listOf(0xFF14B8A6, 0xFF06B6D4),
        "flowers" to listOf(0xFFEC4899, 0xFFF59E0B), "matrix" to listOf(0xFF16A34A, 0xFF4ADE80), "stars" to listOf(0xFF6366F1, 0xFFF59E0B),
    ).mapValues { (_, v) -> v.map { it.toInt() } }

    @Test
    fun whiteOnAmberAndEmeraldFailsAA() {
        // the finding of the review: white text on these gradients is below 4.5:1
        assertTrue(Contrast.ratio(Contrast.WHITE, 0xFFF59E0B.toInt()) < Contrast.AA)
        assertTrue(Contrast.ratio(Contrast.WHITE, 0xFF10B981.toInt()) < Contrast.AA)
    }

    @Test
    fun theTextReachesAAOnEveryColourOfEveryGradient() {
        for ((id, stops) in gradients) {
            val text = Contrast.textOn(stops)
            Contrast.readableStops(stops, text).forEach { c ->
                assertTrue("$id: ${"%08X".format(c)} is ${Contrast.ratio(text, c)}", Contrast.ratio(text, c) >= Contrast.AA)
            }
        }
    }

    @Test
    fun lightGradientsGetDarkTextAndTheIndigoKeepsWhite() {
        assertEquals(Contrast.INK, Contrast.textOn(gradients.getValue("amber")))
        assertEquals(Contrast.INK, Contrast.textOn(gradients.getValue("emerald")))
        assertEquals(Contrast.WHITE, Contrast.textOn(gradients.getValue("dark")))
        assertEquals(Contrast.WHITE, Contrast.textOn(gradients.getValue("pink")))
    }

    @Test
    fun theKnownValuesOfWcag() {
        assertEquals(21.0, Contrast.ratio(Contrast.WHITE, 0xFF000000.toInt()), 0.01)
        assertEquals(1.0, Contrast.ratio(Contrast.WHITE, Contrast.WHITE), 0.0001)
    }
}
