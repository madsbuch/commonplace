// Ported from Murmur's LAN plugin (github.com/madsbuch/murmur).
fn main() {
    tauri_plugin::Builder::new(&[
        "start",
        "stop",
        "is_mobile",
        "register_listener",
        "remove_listener",
    ])
    .android_path("android")
    .build();
}
