// `take` is the plugin's own (Rust, then Kotlin on Android); the listener
// commands are Tauri's, for the `shared` event.
const COMMANDS: &[&str] = &["take", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
