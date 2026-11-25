package com.madsbuch.commonplace.sharetarget

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.WebView
import androidx.core.content.IntentCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

@InvokeArg
class TakeArgs {
    var most: Long = 0
}

/** One share: its text (an address, often with words around it) and its files. */
private class Shared(val text: String?, val subject: String?, val files: List<Uri>)

/**
 * What other apps share to this one (LIB-30). The share sheet starts the
 * app's activity with ACTION_SEND (text/plain or application/pdf) or
 * ACTION_SEND_MULTIPLE (PDFs); the filters are in the app's manifest
 * (scripts/android-share.mjs). The activity is singleTask, so a share while
 * the app runs arrives as a new intent. Shares wait here until the frontend
 * takes them: it asks when it starts, when the app comes to the front, and
 * when `shared` says one arrived. Files are read when taken, within the
 * activity's grant to read them.
 */
@TauriPlugin
class ShareTargetPlugin(private val activity: Activity) : Plugin(activity) {
    private val pending = mutableListOf<Shared>()
    private var launchSeen = false

    override fun load(webView: WebView) {
        super.load(webView)
        seeLaunch()
    }

    override fun onNewIntent(intent: Intent) {
        if (receive(intent)) trigger("shared", JSObject())
    }

    /** The intent the app was started with, once: a share that started it. */
    @Synchronized
    private fun seeLaunch() {
        if (launchSeen) return
        launchSeen = true
        val intent = activity.intent ?: return
        // Opened again from the recent apps, Android hands back the intent the
        // app was first started with; that share was taken then.
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
        // Taken: the activity's intent no longer says "share", should anything look again.
        if (receive(intent)) activity.intent = Intent(Intent.ACTION_MAIN).setComponent(intent.component)
    }

    private fun receive(intent: Intent): Boolean {
        val files = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.toList() ?: emptyList()
            else -> return false
        }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
        if (text.isNullOrBlank() && files.isEmpty()) return false
        synchronized(pending) { pending.add(Shared(text, subject, files)) }
        return true
    }

    @Command
    fun take(invoke: Invoke) {
        val args = invoke.parseArgs(TakeArgs::class.java)
        seeLaunch()
        val taken = synchronized(pending) { pending.toList().also { pending.clear() } }
        thread(name = "share-take") {
            try {
                val shares = JSArray()
                for (s in taken) {
                    val files = JSArray()
                    for (uri in s.files) files.put(read(uri, args.most))
                    val share = JSObject()
                    share.put("text", s.text)
                    share.put("subject", s.subject)
                    share.put("files", files)
                    shares.put(share)
                }
                val result = JSObject()
                result.put("shares", shares)
                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject(e.message ?: "What was shared couldn't be read")
            }
        }
    }

    /** A shared file: its name, type and size, and its bytes (base64) unless it's larger than `most`. */
    private fun read(uri: Uri, most: Long): JSObject {
        val out = JSObject()
        val resolver = activity.contentResolver
        var name: String? = null
        var size = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                    val s = c.getColumnIndex(OpenableColumns.SIZE)
                    if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
                }
            }
        } catch (e: Exception) {
            // Some providers answer no queries; the stream still reads.
        }
        out.put("name", name ?: uri.lastPathSegment ?: "Shared file")
        out.put("type", resolver.getType(uri) ?: "")
        if (size > most) {
            out.put("size", size)
            return out
        }
        try {
            val input = resolver.openInputStream(uri)
            if (input == null) {
                out.put("problem", "it couldn't be opened")
                return out
            }
            val bytes = ByteArrayOutputStream()
            input.use {
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = it.read(buf)
                    if (n < 0) break
                    bytes.write(buf, 0, n)
                    if (bytes.size() > most) {
                        out.put("size", bytes.size().toLong())
                        return out
                    }
                }
            }
            out.put("size", bytes.size().toLong())
            out.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
        } catch (e: Exception) {
            out.put("problem", e.message ?: "it couldn't be read")
        }
        return out
    }
}
