# Keep the Tauri plugin class and its annotated members (invoked via
# reflection), and SyncNative, whose `syncNow` the JNI entry point in
# src-tauri/src/sync/background.rs implements by name.
-keep class com.madsbuch.mybook.syncbg.** { *; }
