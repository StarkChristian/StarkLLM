package com.starkllm.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.starkllm.app.MainActivity
import com.starkllm.app.R
import com.starkllm.app.data.AppPrefs
import com.starkllm.app.data.Deadline
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Home-screen widget: the next three open deadlines, from what the app last read from the PC (no network here). */
class DeadlinesWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = render(context, manager, ids)

    companion object {
        private val ROWS = listOf(R.id.widget_row1, R.id.widget_row2, R.id.widget_row3)

        fun update(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, DeadlinesWidget::class.java))
            if (ids.isNotEmpty()) render(context, manager, ids)
        }

        fun line(context: Context, d: Deadline): String {
            val date = runCatching { LocalDate.parse(d.date).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) }.getOrDefault(d.date)
            val what = listOfNotNull(d.sender ?: d.title ?: d.filename, d.amount).joinToString(" · ")
            val mark = if (d.state == "overdue" || d.state == "today") "● " else ""
            return "$mark$date  $what"
        }

        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val deadlines = AppPrefs(context).cachedDeadlines.take(3)
            val open = PendingIntent.getActivity(
                context, 2,
                Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN, MainActivity.OPEN_DEADLINES),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            for (id in ids) {
                val views = RemoteViews(context.packageName, R.layout.widget_deadlines)
                views.setOnClickPendingIntent(R.id.widget_root, open)
                views.setViewVisibility(R.id.widget_empty, if (deadlines.isEmpty()) View.VISIBLE else View.GONE)
                ROWS.forEachIndexed { i, row ->
                    val d = deadlines.getOrNull(i)
                    views.setViewVisibility(row, if (d == null) View.GONE else View.VISIBLE)
                    if (d != null) views.setTextViewText(row, line(context, d))
                }
                manager.updateAppWidget(id, views)
            }
        }
    }
}
