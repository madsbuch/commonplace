//! Work that carries on with the app out of sight (WORK-1 to WORK-3).
//!
//! On Android, a web view's JavaScript keeps running in the background, but
//! the system freezes a background app, cuts its network under Doze, and
//! kills it when memory is short. A foreground service ("dataSync") keeps
//! the app in the foreground's standing while work runs: its process,
//! network and a partial wake lock, with a notification saying what it's
//! doing (`WorkService.kt`).
//!
//! On a computer, the system stays awake while work runs: `caffeinate -i` on
//! macOS, `systemd-inhibit --what=idle:sleep` on Linux, each holding until
//! its `cat` sees its input closed (when the work ends, or the app does).
//!
//! The app's Rust keeps the list of what runs (`work.rs` in the app) and
//! calls `show` with what's running whenever it changes, or `stop`.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowArgs {
    /// What's running, each as a line of the notification.
    pub titles: Vec<String>,
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use serde::de::DeserializeOwned;
    use tauri::plugin::{PluginApi, PluginHandle};
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> Result<BackgroundWork<R>> {
        let handle = api.register_android_plugin("com.madsbuch.mybook.work", "BackgroundWorkPlugin")?;
        Ok(BackgroundWork(handle))
    }

    pub struct BackgroundWork<R: Runtime>(PluginHandle<R>);

    impl<R: Runtime> BackgroundWork<R> {
        /// Runs in the foreground (or carries on doing so), saying what runs.
        pub fn show(&self, titles: Vec<String>) -> Result<()> {
            self.0.run_mobile_plugin::<serde_json::Value>("show", ShowArgs { titles })?;
            Ok(())
        }
        /// Nothing runs any more.
        pub fn stop(&self) -> Result<()> {
            self.0.run_mobile_plugin::<serde_json::Value>("stop", ())?;
            Ok(())
        }
    }
}

#[cfg(not(target_os = "android"))]
mod computer {
    use super::*;
    use serde::de::DeserializeOwned;
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;
    use tauri::plugin::PluginApi;
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, _api: PluginApi<R, C>) -> Result<BackgroundWork<R>> {
        Ok(BackgroundWork { awake: Mutex::new(None), _r: std::marker::PhantomData })
    }

    pub struct BackgroundWork<R: Runtime> {
        /// The process keeping the computer awake, while work runs.
        awake: Mutex<Option<Child>>,
        _r: std::marker::PhantomData<fn() -> R>,
    }

    // Spec: WORK-3
    /// A process that keeps the computer from sleeping for idleness until its input closes.
    fn keep_awake() -> std::io::Result<Child> {
        let mut command = if cfg!(target_os = "macos") {
            let mut c = Command::new("caffeinate");
            c.args(["-i", "cat"]);
            c
        } else {
            let mut c = Command::new("systemd-inhibit");
            c.args(["--what=idle:sleep", "--who=Commonplace", "--why=Working on your behalf", "--mode=block", "cat"]);
            c
        };
        command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    }

    impl<R: Runtime> BackgroundWork<R> {
        pub fn show(&self, _titles: Vec<String>) -> Result<()> {
            let mut awake = self.awake.lock().map_err(|e| Error::Other(e.to_string()))?;
            if awake.is_none() {
                *awake = Some(keep_awake().map_err(|e| Error::Other(format!("couldn't keep the computer awake: {e}")))?);
            }
            Ok(())
        }
        pub fn stop(&self) -> Result<()> {
            let mut awake = self.awake.lock().map_err(|e| Error::Other(e.to_string()))?;
            if let Some(mut child) = awake.take() {
                // Closing its input ends `cat`, and with it the hold.
                drop(child.stdin.take());
                let _ = child.wait();
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "android")]
pub use android::BackgroundWork;
#[cfg(not(target_os = "android"))]
pub use computer::BackgroundWork;

pub trait BackgroundWorkExt<R: Runtime> {
    fn background_work(&self) -> &BackgroundWork<R>;
}

impl<R: Runtime, T: Manager<R>> BackgroundWorkExt<R> for T {
    fn background_work(&self) -> &BackgroundWork<R> {
        self.state::<BackgroundWork<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("background-work")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let s = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let s = computer::init(app, api)?;
            app.manage(s);
            Ok(())
        })
        .build()
}
