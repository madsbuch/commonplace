package com.madsbuch.mybook.work

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ShowArgs {
    var titles: List<String> = emptyList()
}

/**
 * Work in the foreground (WORK-1, WORK-2): the app's Rust calls `show` with
 * what's running whenever that changes, and `stop` when nothing is. The
 * service does the holding; this starts it, or tells it what changed.
 */
@TauriPlugin
class BackgroundWorkPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())

    override fun load(webView: WebView) {
        super.load(webView)
        // The page's process keeps the app's standing out of sight, so work
        // in its JavaScript isn't the first thing let go when memory is short.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
    }

    @Command
    fun show(invoke: Invoke) {
        val args = invoke.parseArgs(ShowArgs::class.java)
        main.post {
            try {
                WorkService.titles = args.titles
                val running = WorkService.instance
                if (running != null) {
                    running.refresh()
                } else {
                    askToNotify()
                    ContextCompat.startForegroundService(activity, Intent(activity, WorkService::class.java))
                }
                invoke.resolve()
            } catch (error: Exception) {
                // Android 12 and later refuse to start it from the background.
                invoke.reject(error.message ?: error.javaClass.simpleName)
            }
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        main.post {
            WorkService.titles = emptyList()
            WorkService.instance?.refresh()
            invoke.resolve()
        }
    }

    /** Android 13 and later show the notification only once allowed; asked once. */
    private fun askToNotify() {
        if (Build.VERSION.SDK_INT < 33) return
        val permission = Manifest.permission.POST_NOTIFICATIONS
        if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) return
        val prefs = activity.getSharedPreferences("background-work", Context.MODE_PRIVATE)
        if (prefs.getBoolean("asked-to-notify", false)) return
        prefs.edit().putBoolean("asked-to-notify", true).apply()
        ActivityCompat.requestPermissions(activity, arrayOf(permission), 4712)
    }
}
