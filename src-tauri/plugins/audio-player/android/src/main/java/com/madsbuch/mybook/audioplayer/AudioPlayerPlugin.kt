package com.madsbuch.mybook.audioplayer

import android.app.Activity
import android.content.ComponentName
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture
import java.io.File

@InvokeArg
class ChapterArg {
    var title: String = ""
    var start: Double = 0.0
}

@InvokeArg
class RecordingArgs {
    lateinit var id: String
    lateinit var path: String
    var title: String = ""
    var chapters: List<ChapterArg> = emptyList()
    var position: Double = 0.0
    var play: Boolean = false
    var speed: Double = 1.0
}

@InvokeArg
class SeekArgs {
    var seconds: Double = 0.0
}

@InvokeArg
class SpeedArgs {
    var speed: Double = 1.0
}

/**
 * The app's side of [PlaybackService] (AUD-10). What plays is pushed to the
 * app as "state" events: on every change, and every second while playing.
 */
@TauriPlugin
class AudioPlayerPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val waiting = mutableListOf<(MediaController) -> Unit>()

    private val ticker = object : Runnable {
        override fun run() {
            emitState()
            if (controller?.isPlaying == true) main.postDelayed(this, 1000)
        }
    }

    override fun load(webView: WebView) {
        super.load(webView)
        main.post { connect() }
    }

    private fun connect() {
        if (future != null) return
        val token = SessionToken(activity, ComponentName(activity, PlaybackService::class.java))
        val pending = MediaController.Builder(activity, token).buildAsync()
        future = pending
        pending.addListener({
            val ready = try {
                pending.get()
            } catch (error: Exception) {
                future = null
                return@addListener
            }
            controller = ready
            ready.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) {
                    emitState()
                    main.removeCallbacks(ticker)
                    if (player.isPlaying) main.postDelayed(ticker, 1000)
                }
            })
            waiting.forEach { it(ready) }
            waiting.clear()
            emitState()
        }, ContextCompat.getMainExecutor(activity))
    }

    /** Runs on the main thread once the controller is connected. */
    private fun withController(invoke: Invoke, action: (MediaController) -> Any?) {
        main.post {
            val run = { c: MediaController ->
                try {
                    when (val result = action(c)) {
                        is JSObject -> invoke.resolve(result)
                        else -> invoke.resolve()
                    }
                } catch (error: Exception) {
                    invoke.reject(error.message ?: "Player error")
                }
            }
            val ready = controller
            if (ready != null) run(ready) else {
                waiting.add(run)
                connect()
            }
        }
    }

    private fun stateObject(c: MediaController): JSObject {
        val state = JSObject()
        state.put("id", c.currentMediaItem?.mediaId ?: "")
        state.put("playing", c.isPlaying || (c.playWhenReady && c.playbackState == Player.STATE_BUFFERING))
        state.put("position", c.currentPosition / 1000.0)
        val duration = c.duration
        state.put("duration", if (duration == C.TIME_UNSET) 0.0 else duration / 1000.0)
        state.put("speed", c.playbackParameters.speed.toDouble())
        state.put("ended", c.playbackState == Player.STATE_ENDED)
        return state
    }

    private fun emitState() {
        val c = controller ?: return
        trigger("state", stateObject(c))
    }

    /** A recording, from its file, with its chapters, at a position. */
    @Command
    fun setRecording(invoke: Invoke) {
        val args = invoke.parseArgs(RecordingArgs::class.java)
        withController(invoke) { c ->
            PlaybackService.instance?.player?.starts = args.chapters.map { (it.start * 1000).toLong() }
            val uri = Uri.fromFile(File(args.path))
            val item = MediaItem.Builder()
                .setMediaId(args.id)
                .setUri(uri)
                // Survives the hand-over to the service; see onAddMediaItems.
                .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
                .setMediaMetadata(MediaMetadata.Builder().setTitle(args.title).setArtist("Commonplace").build())
                .build()
            c.setMediaItem(item, (args.position * 1000).toLong())
            c.setPlaybackSpeed(args.speed.toFloat())
            c.prepare()
            if (args.play) c.play()
            null
        }
    }

    @Command
    fun play(invoke: Invoke) = withController(invoke) { c ->
        if (c.playbackState == Player.STATE_ENDED) c.seekTo(0)
        c.play()
    }

    @Command
    fun pause(invoke: Invoke) = withController(invoke) { it.pause() }

    @Command
    fun toggle(invoke: Invoke) = withController(invoke) { c ->
        if (c.isPlaying) c.pause() else {
            if (c.playbackState == Player.STATE_ENDED) c.seekTo(0)
            c.play()
        }
    }

    @Command
    fun seekTo(invoke: Invoke) {
        val args = invoke.parseArgs(SeekArgs::class.java)
        withController(invoke) { it.seekTo((args.seconds * 1000).toLong()) }
    }

    @Command
    fun setSpeed(invoke: Invoke) {
        val args = invoke.parseArgs(SpeedArgs::class.java)
        withController(invoke) { it.setPlaybackSpeed(args.speed.toFloat()) }
    }

    @Command
    fun stop(invoke: Invoke) = withController(invoke) { c ->
        c.stop()
        c.clearMediaItems()
    }

    @Command
    fun getState(invoke: Invoke) = withController(invoke) { stateObject(it) }
}
