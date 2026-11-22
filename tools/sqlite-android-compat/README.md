# sqlite-android-compat

Applies every migration with SQLite 3.39, what Android 14 ships, then makes
the writes the app makes and checks the sync triggers recorded them. The
trigger SQL sticks to what that version understands, so the database stays
readable by any SQLite an Android device might open it with.

    cargo run --manifest-path tools/sqlite-android-compat/Cargo.toml -- .

Runs in the Android CI workflow. Kept out of `src-tauri`'s build because it
links a second, older SQLite.
