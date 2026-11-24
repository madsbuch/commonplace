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
class QueueItemArg {
    var id: String = ""
    var path: String = ""
}

/** What to play (AUD-6, AUD-10): a recording's pieces, a file each, or a recording made before as one file with its chapters' starts. */
@InvokeArg
class QueueArgs {
    var items: List<QueueItemArg> = emptyList()
    var index: Int = 0
    var position: Double = 0.0
    var play: Boolean = false
    var speed: Double = 1.0
    var title: String = ""
    var starts: List<Double> = emptyList()
}

@InvokeArg
class ItemsArgs {
    var items: List<QueueItemArg> = emptyList()
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
    /** The recording's title, for pieces added later. */
    private var title = ""

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

    private fun mediaItem(id: String, path: String): MediaItem {
        val uri = Uri.fromFile(File(path))
        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(uri)
            // Survives the hand-over to the service; see onAddMediaItems.
            .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist("Commonplace").build())
            .build()
    }

    /** A queue: a recording's pieces from one of them, or one file with its chapters, at a position. Set by the app's Rust. */
    @Command
    fun setQueue(invoke: Invoke) {
        val args = invoke.parseArgs(QueueArgs::class.java)
        withController(invoke) { c ->
            title = args.title
            PlaybackService.instance?.player?.starts = args.starts.map { (it * 1000).toLong() }
            val items = args.items.map { mediaItem(it.id, it.path) }
            c.setMediaItems(items, args.index.coerceIn(0, maxOf(0, items.size - 1)), (args.position * 1000).toLong())
            c.setPlaybackSpeed(args.speed.toFloat())
            c.prepare()
            if (args.play) c.play()
            null
        }
    }

    /**
     * Pieces made since (AUD-6), added after the queue's last. If it had
     * played to its end waiting for them, it goes on with the first.
     */
    @Command
    fun extendQueue(invoke: Invoke) {
        val args = invoke.parseArgs(ItemsArgs::class.java)
        withController(invoke) { c ->
            val count = c.mediaItemCount
            val queued = (0 until count).map { c.getMediaItemAt(it).mediaId }.toSet()
            val fresh = args.items.filter { it.id !in queued }.map { mediaItem(it.id, it.path) }
            if (fresh.isNotEmpty()) {
                val waited = c.playbackState == Player.STATE_ENDED && c.playWhenReady
                c.addMediaItems(fresh)
                if (waited) {
                    c.seekTo(count, 0)
                    c.play()
                }
            }
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
