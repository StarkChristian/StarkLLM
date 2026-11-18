package com.starkllm.app.data

import android.content.Context
import kotlinx.serialization.builtins.ListSerializer

/**
 * The phone's own settings and small caches: app lock, reminders, the chosen workspace and model, the deadlines the
 * home-screen widget shows, and which reminders were already shown. Nothing here is secret; nothing leaves the phone.
 */
class AppPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("app", Context.MODE_PRIVATE)
    private val deadlines = ListSerializer(Deadline.serializer())

    var appLock: Boolean
        get() = prefs.getBoolean("appLock", false)
        set(v) { prefs.edit().putBoolean("appLock", v).apply() }

    var reminders: Boolean
        get() = prefs.getBoolean("reminders", false)
        set(v) { prefs.edit().putBoolean("reminders", v).apply() }

    var workspaceId: Int
        get() = prefs.getInt("workspaceId", 0)
        set(v) { prefs.edit().putInt("workspaceId", v).apply() }

    /** null: the PC's default model */
    var model: String?
        get() = prefs.getString("model", null)
        set(v) { prefs.edit().putString("model", v).apply() }

    var useKnowledgeBase: Boolean
        get() = prefs.getBoolean("kb", false)
        set(v) { prefs.edit().putBoolean("kb", v).apply() }

    /** the open deadlines last seen (widget, reminders), soonest first */
    var cachedDeadlines: List<Deadline>
        get() = prefs.getString("deadlines", null)?.let { runCatching { json.decodeFromString(deadlines, it) }.getOrNull() }.orEmpty()
        set(v) { prefs.edit().putString("deadlines", json.encodeToString(deadlines, v)).apply() }

    /** a reminder is shown once per deadline and day */
    fun alreadyReminded(key: String, today: String): Boolean = prefs.getString("reminded:$key", null) == today

    fun markReminded(key: String, today: String) {
        prefs.edit().putString("reminded:$key", today).apply()
    }
}

/** The open deadlines worth a look, soonest first (overdue, today, within a week, later) */
fun openDeadlines(all: List<Deadline>): List<Deadline> {
    val order = listOf("overdue", "today", "soon", "upcoming")
    return all.filter { !it.done }.sortedWith(compareBy({ order.indexOf(it.state).let { i -> if (i < 0) 9 else i } }, { it.date }))
}
