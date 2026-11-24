//! Recordings played on Android (AUD-10): the web view can't reach the
//! phone's media controls, and it stops when the app goes to the background.
//! This plays through Media3 in a foreground service instead, which keeps
//! playing with the screen off and gives the lock screen, notification and
//! headphone controls (skipping between a recording's chapters). Ported from
//! learn-polish's song player. Elsewhere it does nothing: computers play in
//! the web view.
//!
//! The app's Rust sets what plays (`set_queue`: a recording's pieces, a file
//! each, or a recording made before as one file), adds pieces as they're
//! made (`extend_queue`), and asks where it is (`state`), so a recording made
//! as it's listened to keeps ahead with the app in the background (AUD-6).

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub type Result<T> = std::result::Result<T, String>;

/// A file to play, by the id the app knows it by.
#[derive(Debug, Clone, Serialize)]
pub struct QueueItem {
    pub id: String,
    pub path: String,
}

/// What to play: items in order, from one of them, at a moment of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub items: Vec<QueueItem>,
    pub index: usize,
    /// Seconds into `items[index]`.
    pub position: f64,
    pub play: bool,
    pub speed: f64,
    pub title: String,
    /// A recording made before as one file: where its chapters start, in seconds.
    pub starts: Vec<f64>,
}

/// Where the player is: the item playing (its id) and how far into it.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct State {
    pub id: String,
    pub playing: bool,
    pub position: f64,
}

#[derive(Serialize)]
struct Items<'a> {
    items: &'a [QueueItem],
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use tauri::plugin::PluginHandle;

    pub struct AudioPlayer<R: Runtime>(pub(crate) PluginHandle<R>);

    impl<R: Runtime> AudioPlayer<R> {
        /// Plays `queue` (blocks until the player has it: call it off the async runtime).
        pub fn set_queue(&self, queue: &Queue) -> Result<()> {
            self.0.run_mobile_plugin::<serde_json::Value>("setQueue", queue).map(|_| ()).map_err(|e| e.to_string())
        }

        /// Adds the items that follow the queue's last.
        pub fn extend_queue(&self, items: &[QueueItem]) -> Result<()> {
            self.0.run_mobile_plugin::<serde_json::Value>("extendQueue", Items { items }).map(|_| ()).map_err(|e| e.to_string())
        }

        pub fn state(&self) -> Result<State> {
            self.0.run_mobile_plugin::<State>("getState", ()).map_err(|e| e.to_string())
        }
    }
}

#[cfg(not(target_os = "android"))]
mod other {
    use super::*;

    pub struct AudioPlayer<R: Runtime>(pub(crate) std::marker::PhantomData<fn() -> R>);

    const ELSEWHERE: &str = "computers play recordings in the web view";

    impl<R: Runtime> AudioPlayer<R> {
        pub fn set_queue(&self, _queue: &Queue) -> Result<()> {
            Err(ELSEWHERE.into())
        }

        pub fn extend_queue(&self, items: &[QueueItem]) -> Result<()> {
            let _ = Items { items };
            Err(ELSEWHERE.into())
        }

        pub fn state(&self) -> Result<State> {
            Err(ELSEWHERE.into())
        }
    }
}

#[cfg(target_os = "android")]
pub use android::AudioPlayer;
#[cfg(not(target_os = "android"))]
pub use other::AudioPlayer;

pub trait AudioPlayerExt<R: Runtime> {
    fn audio_player(&self) -> &AudioPlayer<R>;
}

impl<R: Runtime, T: Manager<R>> AudioPlayerExt<R> for T {
    fn audio_player(&self) -> &AudioPlayer<R> {
        self.state::<AudioPlayer<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("audio-player")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            app.manage(AudioPlayer(_api.register_android_plugin("com.madsbuch.mybook.audioplayer", "AudioPlayerPlugin")?));
            #[cfg(not(target_os = "android"))]
            app.manage(AudioPlayer::<R>(std::marker::PhantomData));
            Ok(())
        })
        .build()
}
