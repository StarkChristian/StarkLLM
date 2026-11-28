package com.starkllm.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.provider.CalendarContract
import android.widget.Toast
import com.starkllm.app.R
import com.starkllm.app.data.Deadline
import java.time.LocalDate
import java.time.ZoneId

/**
 * "Add to calendar": the phone's calendar app opens with the deadline filled in as an all-day event, and the user saves
 * it there (or not). Android's insert intent; StarkLLM needs no calendar permission and reads no calendar.
 */
object CalendarInsert {
    /** "Stadtwerke Aachen GmbH · 52,40 EUR": what the deadline is about, as the PC read it */
    fun title(d: Deadline): String = listOfNotNull(d.sender ?: d.title ?: d.filename, d.amount).joinToString(" · ").ifBlank { d.text.take(80) }

    /** the sentence the date was read from, and the letter it is in */
    fun description(d: Deadline): String = listOfNotNull(d.text.trim().ifBlank { null }, d.filename).joinToString("\n\n")

    /** null: the PC sent no readable date */
    fun intent(d: Deadline, zone: ZoneId = ZoneId.systemDefault()): Intent? {
        val day = runCatching { LocalDate.parse(d.date) }.getOrNull() ?: return null
        val begin = day.atStartOfDay(zone).toInstant().toEpochMilli()
        val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        return Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
            .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, true)
            .putExtra(CalendarContract.Events.TITLE, title(d))
            .putExtra(CalendarContract.Events.DESCRIPTION, description(d))
            .putExtra(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_FREE)
    }

    fun open(context: Context, d: Deadline) {
        val intent = intent(d) ?: return
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(context, R.string.calendar_unavailable, Toast.LENGTH_LONG).show()
        }
    }
}
