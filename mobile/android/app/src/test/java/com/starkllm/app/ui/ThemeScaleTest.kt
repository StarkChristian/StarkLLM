package com.starkllm.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class ThemeScaleTest {
    @Test
    fun `larger system text is followed by 40 percent`() {
        assertEquals(1f, dampedFontScale(1f), 0.001f)
        assertEquals(1.12f, dampedFontScale(1.3f), 0.001f)
        assertEquals(1.4f, dampedFontScale(2f), 0.001f)
        assertEquals(0.85f, dampedFontScale(0.85f), 0.001f)
    }

    @Test
    fun `a larger display zoom is followed by half`() {
        assertEquals(3.09375f, dampedDensity(510f / 160f, 480f / 160f), 0.001f)
        assertEquals(3f, dampedDensity(3f, 3f), 0.001f)
        assertEquals(2.5f, dampedDensity(2.5f, 3f), 0.001f)
    }
}
