//! What other apps share to this one (LIB-30), on Android: a web address
//! (the text of a share) or PDFs (its streams). The app's activity receives
//! the share sheet's intents (the filters `scripts/android-share.mjs` adds to
//! the generated manifest); `ShareTargetPlugin.kt` keeps them until the
//! frontend takes them, reads each file then, and says `shared` when one
//! arrives while the app runs. Elsewhere nothing is ever shared, and `take`
//! says so.

use serde::Serialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

#[derive(Serialize)]
struct TakeArgs {
    /// Files larger than this many bytes come without their data.
    most: u64,
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use serde::de::DeserializeOwned;
    use tauri::plugin::{PluginApi, PluginHandle};
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> Result<ShareTarget<R>> {
        Ok(ShareTarget(api.register_android_plugin("com.madsbuch.commonplace.sharetarget", "ShareTargetPlugin")?))
    }

    pub struct ShareTarget<R: Runtime>(PluginHandle<R>);

    impl<R: Runtime> ShareTarget<R> {
        /// Blocks while the files are read: call it off the async runtime.
        pub fn take(&self, most: u64) -> Result<serde_json::Value> {
            Ok(self.0.run_mobile_plugin::<serde_json::Value>("take", TakeArgs { most })?)
        }
    }
}

#[cfg(not(target_os = "android"))]
mod other {
    use super::*;
    use serde::de::DeserializeOwned;
    use tauri::plugin::PluginApi;
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, _api: PluginApi<R, C>) -> Result<ShareTarget<R>> {
        Ok(ShareTarget(std::marker::PhantomData))
    }

    pub struct ShareTarget<R: Runtime>(std::marker::PhantomData<fn() -> R>);

    impl<R: Runtime> ShareTarget<R> {
        pub fn take(&self, most: u64) -> Result<serde_json::Value> {
            let _ = TakeArgs { most };
            Ok(serde_json::json!({ "shares": [] }))
        }
    }
}

#[cfg(target_os = "android")]
pub use android::ShareTarget;
#[cfg(not(target_os = "android"))]
pub use other::ShareTarget;

/// Everything shared since the last time, each file with its data (base64)
/// unless it's larger than `most` bytes; taken once.
#[tauri::command]
async fn take<R: Runtime>(app: tauri::AppHandle<R>, most: u64) -> std::result::Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<ShareTarget<R>>().take(most))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("share-target")
        .invoke_handler(tauri::generate_handler![take])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let s = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let s = other::init(app, api)?;
            app.manage(s);
            Ok(())
        })
        .build()
}
