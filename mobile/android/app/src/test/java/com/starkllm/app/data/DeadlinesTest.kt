package com.starkllm.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class DeadlinesTest {
    private fun d(key: String, date: String, state: String, done: Boolean = false) = Deadline(key = key, date = date, state = state, done = done)

    @Test
    fun overdueFirstThenTodayThenThisWeekThenLaterAndNothingDone() {
        val list = listOf(
            d("later", "2026-12-15", "upcoming"),
            d("done", "2026-11-01", "overdue", done = true),
            d("soon2", "2026-11-24", "soon"),
            d("today", "2026-11-19", "today"),
            d("soon1", "2026-11-22", "soon"),
            d("overdue", "2026-11-10", "overdue"),
        )
        assertEquals(listOf("overdue", "today", "soon1", "soon2", "later"), openDeadlines(list).map { it.key })
    }

    @Test
    fun theDeadlinesOfThePcAreRead() {
        val text = """{"today":"2026-11-18","deadlines":[{"key":"ws:1:2026-12-15:deadline","keys":["x"],"sources":[],"scope":"ws",
            "document_id":1,"workspace_id":1,"filename":"Stadtwerke-Rechnung.txt","title":null,"sender":"Stadtwerke Aachen GmbH",
            "type":"statement","kind":"deadline","date":"2026-12-15","time":null,"amount":"52,40 EUR","notice":null,
            "text":"Es ergibt sich eine Nachzahlung von 52,40 Euro.","page":1,"line":5,"days":27,"state":"upcoming",
            "reminders":[],"reminder_active":false,"done":false}],"counts":{"overdue":0}}"""
        val parsed = json.decodeFromString(Deadlines.serializer(), text)
        val one = parsed.deadlines.single()
        assertEquals("Stadtwerke Aachen GmbH", one.sender)
        assertEquals("52,40 EUR", one.amount)
        assertEquals(27, one.days)
        assertEquals(1, one.workspaceId)
    }
}
