//! Recordings played on Android (AUD-10): the web view can't reach the
//! phone's media controls, and it stops when the app goes to the background.
//! This plays through Media3 in a foreground service instead, which keeps
//! playing with the screen off and gives the lock screen, notification and
//! headphone controls (skipping between a recording's chapters). Ported from
//! learn-polish's song player. Elsewhere it does nothing: computers play in
//! the web view.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("audio-player")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("com.madsbuch.mybook.audioplayer", "AudioPlayerPlugin")?;
            Ok(())
        })
        .build()
}
