/// The real app's identifier: its data folder is named after it. Development
/// builds run under another (see src-tauri/tauri.dev.conf.json).
#[allow(dead_code)]
const PRODUCTION_IDENTIFIER: &str = "com.madsbuch.mybook";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // A development build never runs as the real app: it would open
            // the real database, and with sync, whatever unfinished code does
            // to it would reach every device. `bun run tauri dev` runs it as
            // "My Book Dev" (scripts/tauri.mjs); anything else is stopped here.
            // Spec: DEV-2
            #[cfg(all(debug_assertions, desktop))]
            if app.config().identifier == PRODUCTION_IDENTIFIER {
                eprintln!(
                    "\nThis is a development build running as the real My Book ({PRODUCTION_IDENTIFIER}),\n\
                     which would open your real database. Start it with `bun run tauri dev`,\n\
                     which runs it as \"My Book Dev\" with its own data.\n"
                );
                std::process::exit(1);
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
