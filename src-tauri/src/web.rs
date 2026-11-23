//! Web pages for the library (LIB-28): a blog post fetched by its address,
//! and its figures. Only the address goes out: a plain GET, http or https,
//! no cookies, at most `MOST` bytes. A page that builds itself in the
//! browser (its HTML an empty shell, its text drawn by its JavaScript) is
//! rendered instead: on a computer in a hidden window of the app's own
//! webview, its finished HTML taken with `eval_with_callback`; on Android
//! by the `page-render` plugin's off-screen WebView. The rendered page gets
//! no access to the app: it isn't in any capability.

use serde::Serialize;
use std::time::Duration;
use tauri_plugin_http::reqwest;

/// The most a page or a figure may weigh.
const MOST: usize = 25 * 1024 * 1024;
const WAIT: Duration = Duration::from_secs(30);
/// Some sites turn away what doesn't look like a browser.
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub status: u16,
    pub content_type: String,
    /// Where it ended up, after redirects.
    pub url: String,
    /// The body, as base64.
    pub data: String,
}

/// `url` if it's an http(s) address.
fn web_address(url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url.trim()).map_err(|e| format!("{url} isn't an address: {e}"))?;
    match u.scheme() {
        "http" | "https" => Ok(u),
        other => Err(format!("{other}: addresses aren't fetched")),
    }
}

// Spec: LIB-28
/// Fetches `url` as a browser would, without cookies.
pub async fn get(url: &str) -> Result<Fetched, String> {
    let u = web_address(url)?;
    let client = reqwest::Client::builder().timeout(WAIT).user_agent(AGENT).build().map_err(|e| e.to_string())?;
    let res = client.get(u).send().await.map_err(|e| format!("couldn't fetch {url}: {}", crate::diagnostics::chain(&e)))?;
    if res.content_length().is_some_and(|n| n as usize > MOST) {
        return Err(format!("{url} is larger than {} MB", MOST / (1024 * 1024)));
    }
    let status = res.status().as_u16();
    let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let final_url = res.url().to_string();
    let bytes = res.bytes().await.map_err(|e| format!("{url} stopped arriving: {}", crate::diagnostics::chain(&e)))?;
    if bytes.len() > MOST {
        return Err(format!("{url} is larger than {} MB", MOST / (1024 * 1024)));
    }
    Ok(Fetched { status, content_type, url: final_url, data: crate::library::encode(&bytes) })
}

#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub html: String,
    pub url: String,
}

// Spec: LIB-28
/// The page at `url` as it shows once its scripts have run, on a computer:
/// a hidden window loads it, and its HTML is taken once its text stops growing.
#[cfg(desktop)]
pub async fn render(app: &tauri::AppHandle, url: &str) -> Result<Rendered, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let u = web_address(url)?;
    let label = format!("page-render-{}", NEXT.fetch_add(1, Ordering::SeqCst));
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(u))
        .title("Commonplace: reading a page")
        .visible(false)
        .focused(false)
        .inner_size(1280.0, 2000.0)
        .user_agent(AGENT)
        .on_page_load(move |_w, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(tx) = loaded_tx.lock().ok().and_then(|mut t| t.take()) {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| format!("couldn't open {url} to read it: {e}"))?;
    let result = async {
        tokio::time::timeout(WAIT, loaded_rx).await.map_err(|_| format!("{url} didn't finish loading in {} s", WAIT.as_secs()))?.ok();
        // Its text, until it stops growing (a page that builds itself goes on after "loaded").
        let mut last = 0usize;
        let mut steady = 0;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let n: usize = eval(&window, "document.body ? document.body.innerText.length : 0").await?.parse().unwrap_or(0);
            steady = if n == last && n > 0 { steady + 1 } else { 0 };
            last = n;
            if steady >= 2 && n > 200 {
                break;
            }
        }
        let html: String = serde_json::from_str(&eval(&window, "document.documentElement.outerHTML").await?).map_err(|e| e.to_string())?;
        let at: String = serde_json::from_str(&eval(&window, "location.href").await?).unwrap_or_else(|_| url.to_string());
        Ok(Rendered { html, url: at })
    }
    .await;
    let _ = window.close();
    result
}

/// What `js` comes to in `window`, as JSON.
#[cfg(desktop)]
async fn eval(window: &tauri::WebviewWindow, js: &str) -> Result<String, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    window.eval_with_callback(js, move |out| {
        let _ = tx.send(out);
    }).map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.map_err(|_| "the page didn't answer".to_string())?.ok_or_else(|| "the page didn't answer".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_are_fetched() {
        assert!(web_address("https://z.ai/blog/glm-5.4").is_ok());
        assert!(web_address(" http://example.com/a ").is_ok());
        assert!(web_address("file:///etc/passwd").is_err());
        assert!(web_address("javascript:alert(1)").is_err());
        assert!(web_address("not an address").is_err());
    }
}
