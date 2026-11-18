package com.starkllm.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownParseTest {
    @Test
    fun anAnswerWithHeadingListAndCode() {
        val answer = """
            ## Jahresabrechnung
            Die **Nachzahlung** beträgt 52,40 Euro.

            - fällig am 15.12.2026
            - neuer Abschlag: 81,00 Euro
              - ab Januar
            1. Zahlen
            2) Prüfen
            > Zitat aus dem Brief
            ---
            ```
            812,40 - 760,00 = 52,40
            ```
        """.trimIndent()
        assertEquals(
            listOf(
                Block.Heading(2, "Jahresabrechnung"),
                Block.Paragraph("Die **Nachzahlung** beträgt 52,40 Euro."),
                Block.Item("•", "fällig am 15.12.2026", 0),
                Block.Item("•", "neuer Abschlag: 81,00 Euro", 0),
                Block.Item("•", "ab Januar", 1),
                Block.Item("1.", "Zahlen", 0),
                Block.Item("2.", "Prüfen", 0),
                Block.Quote("Zitat aus dem Brief"),
                Block.Rule,
                Block.Code("812,40 - 760,00 = 52,40"),
            ),
            parseMarkdown(answer),
        )
    }

    @Test
    fun linesOfAParagraphAreJoinedAndAnUnfinishedCodeBlockIsKept() {
        assertEquals(listOf(Block.Paragraph("eins zwei")), parseMarkdown("eins\nzwei"))
        // while the answer streams in, the closing ``` has not arrived yet
        assertEquals(listOf(Block.Paragraph("Rechnung:"), Block.Code("a = 1")), parseMarkdown("Rechnung:\n```\na = 1\n"))
    }
}
