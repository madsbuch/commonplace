// The commands are Kotlin's (android/); Tauri forwards each call there.
// Listing them here generates their permissions. The queue is set and
// extended by the app's Rust, not its frontend.
const COMMANDS: &[&str] = &[
    "set_queue",
    "extend_queue",
    "play",
    "pause",
    "toggle",
    "seek_to",
    "set_speed",
    "stop",
    "get_state",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
