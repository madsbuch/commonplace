package com.madsbuch.mybook.syncbg

/**
 * The app's Rust library, entered directly: the worker runs without the
 * WebView, so there's no Tauri bridge to go through. Implemented by
 * `Java_com_madsbuch_mybook_syncbg_SyncNative_syncNow` in
 * src-tauri/src/sync/background.rs.
 */
object SyncNative {
    init {
        // Already loaded when the app is running; loading again is a no-op.
        System.loadLibrary("my_book_lib")
    }

    /** Syncs with whatever devices of the book answer; returns a summary. */
    @JvmStatic
    external fun syncNow(dbPath: String): String
}
