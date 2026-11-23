//! A web page as it shows once its scripts have run (LIB-28), on Android: an
//! off-screen WebView loads it and its HTML is taken once its text stops
//! growing (`PageRenderPlugin.kt`). Android can't open another window of the
//! app's own, as a computer does (src-tauri/src/web.rs); elsewhere this
//! says so.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

/// The page as it showed, and where it ended up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rendered {
    pub html: String,
    pub url: String,
}

#[derive(Serialize)]
struct RenderArgs<'a> {
    url: &'a str,
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use serde::de::DeserializeOwned;
    use tauri::plugin::{PluginApi, PluginHandle};
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> Result<PageRender<R>> {
        Ok(PageRender(api.register_android_plugin("com.madsbuch.commonplace.pagerender", "PageRenderPlugin")?))
    }

    pub struct PageRender<R: Runtime>(PluginHandle<R>);

    impl<R: Runtime> PageRender<R> {
        /// Blocks until the page is read (up to about 35 s): call it off the async runtime.
        pub fn render(&self, url: &str) -> Result<Rendered> {
            Ok(self.0.run_mobile_plugin::<Rendered>("render", RenderArgs { url })?)
        }
    }
}

#[cfg(not(target_os = "android"))]
mod other {
    use super::*;
    use serde::de::DeserializeOwned;
    use tauri::plugin::PluginApi;
    use tauri::AppHandle;

    pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, _api: PluginApi<R, C>) -> Result<PageRender<R>> {
        Ok(PageRender(std::marker::PhantomData))
    }

    pub struct PageRender<R: Runtime>(std::marker::PhantomData<fn() -> R>);

    impl<R: Runtime> PageRender<R> {
        pub fn render(&self, url: &str) -> Result<Rendered> {
            let _ = RenderArgs { url };
            Err(Error::Other("pages are rendered by the app's own window here".into()))
        }
    }
}

#[cfg(target_os = "android")]
pub use android::PageRender;
#[cfg(not(target_os = "android"))]
pub use other::PageRender;

pub trait PageRenderExt<R: Runtime> {
    fn page_render(&self) -> &PageRender<R>;
}

impl<R: Runtime, T: Manager<R>> PageRenderExt<R> for T {
    fn page_render(&self) -> &PageRender<R> {
        self.state::<PageRender<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("page-render")
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
