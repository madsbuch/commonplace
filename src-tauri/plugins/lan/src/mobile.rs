use crate::Config;
use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

pub struct Lan<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> Result<Lan<R>, tauri::plugin::mobile::PluginInvokeError> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.madsbuch.commonplace.lan", "LanPlugin")?;
    #[cfg(target_os = "ios")]
    let handle: PluginHandle<R> = {
        let _ = api;
        unimplemented!("Commonplace isn't built for iOS")
    };
    Ok(Lan(handle))
}

impl<R: Runtime> Lan<R> {
    pub fn start(&self, config: Config) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("start", serde_json::json!({ "config": config })).map(|_| ()).map_err(|e| e.to_string())
    }
    pub fn stop(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("stop", ()).map(|_| ()).map_err(|e| e.to_string())
    }
}
