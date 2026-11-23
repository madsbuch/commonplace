package com.madsbuch.commonplace.pagerender

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import org.json.JSONTokener

@InvokeArg
class RenderArgs {
    var url: String = ""
}

/**
 * A web page as it shows once its scripts have run (LIB-28): an off-screen
 * WebView loads it, its text is watched until it stops growing (a page that
 * builds itself goes on after "finished"), then its HTML is handed back.
 * The page runs in a WebView of its own, with nothing of the app's.
 */
@TauriPlugin
class PageRenderPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())

    @Command
    fun render(invoke: Invoke) {
        val args = invoke.parseArgs(RenderArgs::class.java)
        main.post { start(args.url, invoke) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun start(url: String, invoke: Invoke) {
        val view = WebView(activity)
        val started = SystemClock.uptimeMillis()
        var done = false
        var polling = false
        var last = -1
        var steady = 0

        fun finish(result: JSObject?, error: String?) {
            if (done) return
            done = true
            try {
                view.stopLoading()
                view.destroy()
            } catch (e: Exception) {
                // Already gone: nothing to free.
            }
            if (result != null) invoke.resolve(result) else invoke.reject(error ?: "The page couldn't be read.")
        }

        fun capture() {
            if (done) return
            view.evaluateJavascript("JSON.stringify({html: document.documentElement.outerHTML, url: location.href})") { value ->
                try {
                    // evaluateJavascript hands back the result as JSON: here a string holding JSON.
                    val inner = JSONTokener(value).nextValue() as? String ?: throw IllegalStateException("no page")
                    val page = JSONObject(inner)
                    val result = JSObject()
                    result.put("html", page.getString("html"))
                    result.put("url", page.getString("url"))
                    finish(result, null)
                } catch (e: Exception) {
                    finish(null, "The page couldn't be read: ${e.message}")
                }
            }
        }

        val poll = object : Runnable {
            override fun run() {
                if (done) return
                if (SystemClock.uptimeMillis() - started > 30_000) {
                    capture()
                    return
                }
                view.evaluateJavascript("document.body ? document.body.innerText.length : 0") { value ->
                    val n = value?.toIntOrNull() ?: 0
                    steady = if (n == last && n > 0) steady + 1 else 0
                    last = n
                    if (steady >= 2 && n > 200) capture() else main.postDelayed(this, 500)
                }
            }
        }

        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        // Laid out as a desktop window would be, so pages that only draw what's in view draw it.
        view.measure(
            View.MeasureSpec.makeMeasureSpec(1280, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, 1280, 2000)
        view.webViewClient = object : WebViewClient() {
            override fun onPageFinished(v: WebView, u: String) {
                if (!polling) {
                    polling = true
                    main.postDelayed(poll, 500)
                }
            }

            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) finish(null, "The page didn't load: ${error.description}")
            }
        }
        // Whatever happens, it ends.
        main.postDelayed({ if (!done) capture() }, 40_000)
        main.postDelayed({ if (!done) finish(null, "The page took too long to read.") }, 50_000)
        view.loadUrl(url)
    }
}
