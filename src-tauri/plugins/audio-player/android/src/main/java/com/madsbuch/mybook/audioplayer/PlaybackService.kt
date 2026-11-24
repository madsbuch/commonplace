package com.madsbuch.mybook.audioplayer

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A recording's chapters on the lock screen (AUD-10): its next and previous
 * are the chapters', not the queue's. A recording made as it's listened to is
 * queued a piece at a time (AUD-6), each piece's id ending in its chapter,
 * chunk and passage; one made before is one file, its chapters at `starts`.
 * Back within the first three seconds of a chapter goes to the one before;
 * later, to its start.
 */
class ChapterPlayer(player: Player) : ForwardingPlayer(player) {
    /** A recording made before as one file: where each chapter starts, in milliseconds. */
    @Volatile
    var starts: List<Long> = emptyList()

    private val skips = listOf(
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
    )

    /** The chapter of the piece at `index` (`<recording>.<chapter>.<chunk>.<passage>`), or null for a file. */
    private fun chapterOf(index: Int): Int? {
        if (index < 0 || index >= mediaItemCount) return null
        val parts = getMediaItemAt(index).mediaId.split('.')
        return if (parts.size >= 4) parts[parts.size - 3].toIntOrNull() else null
    }

    private val pieces: Boolean
        get() = starts.isEmpty() && chapterOf(currentMediaItemIndex) != null

    /** The first piece of the next chapter, if it's queued. */
    private fun nextChapter(): Int? {
        val here = chapterOf(currentMediaItemIndex) ?: return null
        return (currentMediaItemIndex + 1 until mediaItemCount).firstOrNull { chapterOf(it) != here }
    }

    /** The first queued piece of the chapter the piece at `index` is in. */
    private fun chapterStart(index: Int): Int {
        val chapter = chapterOf(index)
        var i = index
        while (i > 0 && chapterOf(i - 1) == chapter) i--
        return i
    }

    private val skipping: Boolean
        get() = starts.size > 1 || pieces

    override fun getAvailableCommands(): Player.Commands {
        val commands = super.getAvailableCommands().buildUpon()
        if (skipping) skips.forEach { commands.add(it) }
        return commands.build()
    }

    override fun isCommandAvailable(command: Int): Boolean =
        (skipping && command in skips) || super.isCommandAvailable(command)

    override fun hasNextMediaItem(): Boolean =
        if (pieces) nextChapter() != null else starts.any { it > currentPosition + 500 }

    override fun hasPreviousMediaItem(): Boolean = if (pieces) true else starts.isNotEmpty()

    override fun seekToNext() {
        if (pieces) {
            nextChapter()?.let { seekTo(it, 0) }
            return
        }
        starts.firstOrNull { it > currentPosition + 500 }?.let { seekTo(it) }
    }

    override fun seekToNextMediaItem() = seekToNext()

    override fun seekToPrevious() {
        if (pieces) {
            val i = currentMediaItemIndex
            val first = chapterStart(i)
            when {
                i > first || currentPosition > 3000 -> seekTo(first, 0)
                first > 0 -> seekTo(chapterStart(first - 1), 0)
                else -> seekTo(0, 0)
            }
            return
        }
        val at = currentPosition
        val i = starts.indexOfLast { it <= at }
        val target = when {
            i < 0 -> 0L
            at - starts[i] > 3000 -> starts[i]
            else -> starts.getOrNull(i - 1) ?: 0L
        }
        seekTo(target)
    }

    override fun seekToPreviousMediaItem() = seekToPrevious()
}

/**
 * Owns the phone's media session: plays a recording with ExoPlayer in the
 * foreground, so it goes on with the screen off and the app in the
 * background, with lock-screen, notification, headphone and Bluetooth
 * controls. The notification stays while a recording is loaded, paused too,
 * and has a Close button. Ported from learn-polish's song player.
 */
class PlaybackService : MediaSessionService() {
    companion object {
        @Volatile
        var instance: PlaybackService? = null
            private set

        /** The notification's Close button. */
        private val CLOSE = SessionCommand("commonplace.close", Bundle.EMPTY)
    }

    private lateinit var exo: ExoPlayer
    lateinit var player: ChapterPlayer
        private set
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        exo = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus= */ true,
            )
            // Pause when headphones are unplugged.
            .setHandleAudioBecomingNoisy(true)
            // The network too: a recording is made ahead of the listener while it plays (AUD-6).
            .setWakeMode(C.WAKE_MODE_NETWORK)
            // Skipping in a spoken recording: 15 s back, 30 s on.
            .setSeekBackIncrementMs(15_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
        player = ChapterPlayer(exo)

        @Suppress("DEPRECATION")
        val close = CommandButton.Builder()
            .setDisplayName("Close")
            .setIconResId(android.R.drawable.ic_menu_close_clear_cancel)
            .setSessionCommand(CLOSE)
            .build()
        @Suppress("DEPRECATION")
        val builder = MediaSession.Builder(this, player)
            .setCallback(SessionCallback())
            .setCustomLayout(ImmutableList.of(close))
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            // Tapping the notification opens the app.
            builder.setSessionActivity(
                PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
        }
        session = builder.build()
        instance = this
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /**
     * Media3 lets the notification go once playback pauses. Keeping the
     * service in the foreground while a recording is loaded keeps the
     * controls up until Close.
     */
    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        val p = session.player
        val loaded = p.mediaItemCount > 0 && p.playbackState != Player.STATE_IDLE
        super.onUpdateNotification(session, startInForegroundRequired || loaded)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app away stops the service unless something plays.
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        instance = null
        session?.release()
        session = null
        exo.release()
        super.onDestroy()
    }

    private inner class SessionCallback : MediaSession.Callback {
        /** Every controller may use Close, the notification's included. */
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon().add(CLOSE).build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands)
                .build()
        }

        /** Close: stop, forget the recording, and let the notification go. */
        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            if (customCommand.customAction == CLOSE.customAction) {
                session.player.stop()
                session.player.clearMediaItems()
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
            return super.onCustomCommand(session, controller, customCommand, args)
        }

        /**
         * Controllers hand media items over without their file URI (Media3
         * strips it), so the plugin sends it in the request metadata and it
         * is restored here.
         */
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val restored = mediaItems.map { item ->
                val uri = item.requestMetadata.mediaUri
                if (uri != null) item.buildUpon().setUri(uri).build() else item
            }.toMutableList()
            return Futures.immediateFuture(restored)
        }
    }
}
