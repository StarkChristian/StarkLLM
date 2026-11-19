package com.starkllm.app.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.starkllm.app.MainActivity
import com.starkllm.app.R
import com.starkllm.app.data.AppPrefs
import com.starkllm.app.data.LinkStore
import com.starkllm.app.data.StarkApi
import com.starkllm.app.data.openDeadlines
import com.starkllm.app.widget.DeadlinesWidget
import java.util.concurrent.TimeUnit

/**
 * Deadline reminders without a cloud push service: every few hours the phone asks the paired PC for its deadlines
 * (only works on the home network; elsewhere nothing happens) and shows a reminder for what is overdue, due today or
 * within a week, once a day per deadline. It also refreshes the home-screen widget.
 */
object Reminders {
    private const val WORK = "deadline-reminders"
    const val CHANNEL = "deadlines"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<ReminderWorker>(3, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        // and once right away, so that switching it on shows at once what is due
        WorkManager.getInstance(context).enqueueUniqueWork("$WORK-now", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<ReminderWorker>().build())
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
    }

    fun channel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.channel_deadlines), NotificationManager.IMPORTANCE_DEFAULT)
        )
    }
}

class ReminderWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val prefs = AppPrefs(applicationContext)
        val link = LinkStore(applicationContext).current() ?: return Result.success()
        val deadlines = runCatching { StarkApi(link).deadlines() }.getOrNull() ?: return Result.success()   // not at home
        val open = openDeadlines(deadlines.deadlines)
        prefs.cachedDeadlines = open
        DeadlinesWidget.update(applicationContext)
        if (!prefs.reminders) return Result.success()
        val allowed = ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!allowed) return Result.success()
        Reminders.channel(applicationContext)
        val open_ = PendingIntent.getActivity(
            applicationContext, 1,
            Intent(applicationContext, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN, MainActivity.OPEN_DEADLINES),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // on the lock screen only "a deadline reminder": sender, amount and text are seen after unlocking the phone
        val redacted = NotificationCompat.Builder(applicationContext, Reminders.CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_starkllm)
            .setContentTitle(applicationContext.getString(R.string.reminder_public_title))
            .setContentText(applicationContext.getString(R.string.reminder_public_text))
            .build()
        for (d in open.filter { it.state in setOf("overdue", "today", "soon") }.take(5)) {
            if (prefs.alreadyReminded(d.key, deadlines.today)) continue
            val whenText = when (d.state) {
                "overdue" -> applicationContext.getString(R.string.deadline_overdue)
                "today" -> applicationContext.getString(R.string.deadline_today)
                else -> applicationContext.resources.getQuantityString(R.plurals.deadline_in_days, d.days, d.days)
            }.replaceFirstChar { it.uppercase() }       // "In 4 Tagen: ..." at the start of the title
            val title = listOfNotNull(d.sender ?: d.title ?: d.filename, d.amount).joinToString(" · ")
            val n = NotificationCompat.Builder(applicationContext, Reminders.CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_starkllm)
                .setContentTitle("$whenText: $title")
                .setContentText(d.text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(d.text))
                .setContentIntent(open_)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(redacted)
                .build()
            runCatching { NotificationManagerCompat.from(applicationContext).notify(d.key.hashCode(), n) }
            prefs.markReminded(d.key, deadlines.today)
        }
        return Result.success()
    }
}
