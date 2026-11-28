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

/**
 * Home-screen widget: the next three open deadlines, from what the app last read from the PC (no network here). With
 * the app lock on it shows only how many are open: sender, amount and text would be readable without unlocking the app.
 */
class DeadlinesWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = render(context, manager, ids)

    companion object {
        private val ROWS = listOf(R.id.widget_row1, R.id.widget_row2, R.id.widget_row3)

        fun update(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            // the home screen's widget and the one on the Galaxy Z Flip's cover screen (CoverDeadlinesWidget)
            for (kind in listOf(DeadlinesWidget::class.java, CoverDeadlinesWidget::class.java)) {
                val ids = manager.getAppWidgetIds(ComponentName(context, kind))
                if (ids.isNotEmpty()) render(context, manager, ids)
            }
        }

        fun line(context: Context, d: Deadline): String {
            val date = runCatching { LocalDate.parse(d.date).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) }.getOrDefault(d.date)
            val what = listOfNotNull(d.sender ?: d.title ?: d.filename, d.amount).joinToString(" · ")
            val mark = if (d.state == "overdue" || d.state == "today") "● " else ""
            return "$mark$date  $what"
        }

        internal fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val prefs = AppPrefs(context)
            val all = prefs.cachedDeadlines
            val lines = if (prefs.appLock) {
                if (all.isEmpty()) emptyList() else listOf(context.resources.getQuantityString(R.plurals.widget_locked, all.size, all.size))
            } else {
                all.take(3).map { line(context, it) }
            }
            val open = PendingIntent.getActivity(
                context, 2,
                Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN, MainActivity.OPEN_DEADLINES),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            for (id in ids) {
                val views = RemoteViews(context.packageName, R.layout.widget_deadlines)
                views.setOnClickPendingIntent(R.id.widget_root, open)
                views.setViewVisibility(R.id.widget_empty, if (lines.isEmpty()) View.VISIBLE else View.GONE)
                ROWS.forEachIndexed { i, row ->
                    val text = lines.getOrNull(i)
                    views.setViewVisibility(row, if (text == null) View.GONE else View.VISIBLE)
                    if (text != null) views.setTextViewText(row, text)
                }
                manager.updateAppWidget(id, views)
            }
        }
    }
}
