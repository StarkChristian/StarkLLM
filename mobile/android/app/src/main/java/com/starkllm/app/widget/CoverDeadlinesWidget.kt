package com.starkllm.app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context

/**
 * The deadlines widget for the cover screen of a Galaxy Z Flip (Flex Window, Settings > Cover screen > Widgets; Samsung's
 * metadata in res/xml/samsung_widget_cover.xml). The same content as on the home screen, from the app's last read, no
 * network. The cover screen can be seen while the phone is closed and locked: with the app lock on it shows only how
 * many deadlines are open, as the home-screen widget does.
 */
class CoverDeadlinesWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = DeadlinesWidget.render(context, manager, ids)
}
