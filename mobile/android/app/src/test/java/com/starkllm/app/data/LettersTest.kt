package com.starkllm.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class LettersTest {
    private val deadline = Deadline("a", "2026-11-20", amount = "52,40 EUR", filename = "Rechnung.pdf", workspaceId = 1, state = "overdue")

    @Test
    fun senderKindAndAmountWhenThePcReadThem() {
        val doc = RecentDocument(1, "Rechnung.pdf", workspaceId = 1, sender = "Stadtwerke", letterKind = "invoice", askedAmount = "10,00 EUR")
        assertEquals("Stadtwerke · Rechnung · 10,00 EUR", documentSummary(doc, "Rechnung", listOf(deadline)))
    }

    @Test
    fun theAmountOfTheLettersDeadlineWhenTheLetterAsksForNone() {
        val doc = RecentDocument(1, "Rechnung.pdf", workspaceId = 1, sender = "Stadtwerke")
        assertEquals("Stadtwerke · 52,40 EUR", documentSummary(doc, null, listOf(deadline)))
        // the same file name in another workspace is another letter
        assertEquals("Stadtwerke", documentSummary(doc.copy(workspaceId = 2), null, listOf(deadline)))
    }

    @Test
    fun theFileNameOnlyWithoutSenderAndKind() {
        assertEquals("IMG_1.jpg", documentSummary(RecentDocument(3, "IMG_1.jpg"), null, emptyList()))
        assertEquals("Rechnung.pdf · 52,40 EUR", documentSummary(RecentDocument(1, "Rechnung.pdf", workspaceId = 1, sender = " "), null, listOf(deadline)))
    }

    @Test
    fun theHomeOfThePcIsReadWithTheLetterFacts() {
        val text = """{"today":"2026-11-28","recent":[{"id":4,"scope":"ws","filename":"a.pdf","workspace":"Briefe","workspace_id":1,
            "added":"2026-11-27","sender":"Stadtwerke","letter_kind":"invoice","asked_amount":null,"first_page":1}],"dates":[]}"""
        val doc = json.decodeFromString(Home.serializer(), text).recent.single()
        assertEquals("Stadtwerke", doc.sender)
        assertEquals("invoice", doc.letterKind)
        assertEquals(null, doc.askedAmount)
    }

    @Test
    fun urgencyComesFromThePcsState() {
        fun u(state: String, done: Boolean = false) = urgencyOf(Deadline("k", "2026-11-28", state = state, done = done))
        assertEquals(Urgency.OVERDUE, u("overdue"))
        assertEquals(Urgency.THIS_WEEK, u("today"))
        assertEquals(Urgency.THIS_WEEK, u("soon"))
        assertEquals(Urgency.LATER, u("upcoming"))
        assertEquals(Urgency.DONE, u("overdue", done = true))
    }
}
