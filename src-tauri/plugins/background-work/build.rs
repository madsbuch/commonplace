// The commands are Kotlin's (android/), called from the app's Rust, not
// from the frontend. Listing them here generates their permissions.
const COMMANDS: &[&str] = &["show", "stop"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
