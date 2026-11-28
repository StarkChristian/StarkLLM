package com.starkllm.app.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

/** The check of the large-text tests finds a text that is cut, and only that one */
class CutTextCheckTest : ScreenTest() {
    @Test
    fun aCutTextIsFound() {
        show {_, _ ->
            Column {
                Text("Kurpfalz Direkt Versicherung AG · Beitragsrechnung", maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(120.dp))
                Text("Erledigt")
            }
        }
        assertEquals(listOf("-: Kurpfalz Direkt Versicherung AG · Beitragsrechnung"), cutTexts())
    }
}
