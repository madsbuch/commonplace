// The command is Kotlin's (android/), called from the app's Rust, not from
// the frontend. Listing it here generates its permission.
const COMMANDS: &[&str] = &["render"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
