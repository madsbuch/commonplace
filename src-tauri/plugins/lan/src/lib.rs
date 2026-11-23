//! Finding the book's devices on the local network, as Murmur does
//! (github.com/madsbuch/murmur, its `lan` plugin, ported): each device
//! advertises `_commonplace._tcp` with its sync port and, in its TXT record,
//! the book's tag, its device id and, while it shows a pairing code, that
//! code's tag; each browses for the others and hands every one it resolves,
//! with all its addresses (IPv6 included, link-local with its scope), to the
//! frontend, which passes them to the app's Rust (`sync_peer_found`).
//!
//! Android uses its own NsdManager (`LanPlugin.kt`, with a multicast lock,
//! stopped while the app is paused); computers use `mdns-sd`.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use desktop::Lan;
#[cfg(any(target_os = "android", target_os = "ios"))]
use mobile::Lan;

/// What this device advertises.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub service_name: String,
    pub port: u16,
    pub device_id: String,
    /// The book's tag; empty while this device isn't in a book.
    pub book: String,
    /// The tag of the pairing code on screen; empty when there's none.
    pub pair: String,
}

fn token(value: &str, empty_ok: bool) -> bool {
    (empty_ok || !value.is_empty()) && value.len() <= 128 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

impl Config {
    fn validate(&self) -> Result<(), String> {
        if self.port == 0 || self.service_name.is_empty() || self.service_name.len() > 63 {
            return Err("Invalid LAN service name or port".into());
        }
        if !token(&self.device_id, false) || !token(&self.book, true) || !token(&self.pair, true) {
            return Err("Invalid LAN device, book or pairing tag".into());
        }
        Ok(())
    }
}

/// A device found: what it advertises and every address it can be reached at.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub device_id: String,
    pub book: String,
    pub pair: String,
    pub addresses: Vec<String>,
    pub port: u16,
}

#[tauri::command]
async fn start<R: Runtime>(app: tauri::AppHandle<R>, config: Config) -> Result<(), String> {
    config.validate()?;
    app.state::<Lan<R>>().start(config)
}

#[tauri::command]
async fn stop<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    app.state::<Lan<R>>().stop()
}

#[tauri::command]
fn is_mobile() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lan")
        .invoke_handler(tauri::generate_handler![start, stop, is_mobile])
        .setup(|app, api| {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let lan = mobile::init(app, api)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let lan = {
                let _ = api;
                desktop::Lan::new(app.clone())
            };
            app.manage(lan);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_outside_any_book_still_advertises_and_browses() {
        let c = Config { service_name: "Commonplace-0123".into(), port: 47832, device_id: "0123-abcd".into(), book: String::new(), pair: String::new() };
        assert!(c.validate().is_ok());
        assert!(Config { book: "a b".into(), ..c.clone() }.validate().is_err());
        assert!(Config { port: 0, ..c }.validate().is_err());
    }
}
