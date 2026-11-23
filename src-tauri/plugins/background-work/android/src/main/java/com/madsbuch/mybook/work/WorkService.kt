package com.madsbuch.mybook.work

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
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps the app working while it's out of sight (WORK-1, WORK-2): a
 * foreground service of type dataSync, so Android neither freezes the app
 * nor cuts its network under Doze, with a partial wake lock so the CPU
 * keeps going with the screen off, and a notification saying what runs.
 * It holds as long as `titles` isn't empty; everything runs on the main thread.
 */
class WorkService : Service() {
    companion object {
        /** What's running, as the app's Rust last said. */
        var titles: List<String> = emptyList()
        /** The service while it runs. */
        var instance: WorkService? = null

        private const val CHANNEL = "work"
        private const val NOTIFICATION = 4711
        /** A wake lock never outlives this, whatever happens to the app. */
        private const val MOST_MS = 6L * 60 * 60 * 1000
    }

    private var wakeLock: PowerManager.WakeLock? = null
    /** In the foreground: before then it mustn't stop (Android takes that for a crash). */
    private var started = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "Work in the background", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Shows while Commonplace answers, records or reads with the app out of sight."
            channel.setShowBadge(false)
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started with startForegroundService: it must go to the foreground
        // now, even if the work has already ended (then it stops at once).
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, NOTIFICATION, notification(), type)
        started = true
        instance = this
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "commonplace:work").also { it.acquire(MOST_MS) }
        }
        refresh()
        // Not restarted on its own: the work lives in the app, which would be gone.
        return START_NOT_STICKY
    }

    /** Shows what runs now, or stops when nothing does. */
    fun refresh() {
        if (!started) return
        if (titles.isEmpty()) {
            finish()
            return
        }
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION, notification())
    }

    // Android 15 limits dataSync work to six hours a day; at the limit it must stop.
    override fun onTimeout(startId: Int, fgsType: Int) {
        finish()
    }

    override fun onDestroy() {
        releaseWakeLock()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun finish() {
        started = false
        // Work that begins now starts the service afresh.
        if (instance === this) instance = null
        releaseWakeLock()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun notification(): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            it.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val shown = titles.ifEmpty { listOf("Finishing") }
        val first = shown.first()
        val text = if (shown.size > 1) "${first}, and ${shown.size - 1} more" else first
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Commonplace is working")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(shown.joinToString("\n")))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
