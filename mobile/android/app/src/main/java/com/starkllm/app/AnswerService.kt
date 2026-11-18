package com.starkllm.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the app awake while an answer is coming in, so that it is not cut off when the user switches to another app
 * (found on the Galaxy Z Flip5: the phone froze the app in the background and the PC saved only the first word).
 * A short foreground service with a quiet notification; it ends with the answer, or after a few minutes at most.
 */
class AnswerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_answers), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 4, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_starkllm)
            .setContentTitle(getString(R.string.answer_notification))
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .build()
        runCatching {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
            else startForeground(ID, notification)
        }.onFailure { stopSelf() }
        return START_NOT_STICKY
    }

    // a short service may run about three minutes; a longer answer goes on only while the app is open
    override fun onTimeout(startId: Int) {
        stopSelf()
    }

    companion object {
        private const val CHANNEL = "answers"
        private const val ID = 7

        fun start(context: Context) {
            runCatching { context.startForegroundService(Intent(context, AnswerService::class.java)) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, AnswerService::class.java)) }
        }
    }
}
