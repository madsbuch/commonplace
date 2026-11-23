//! The work running now (WORK-1 to WORK-3): what the frontend and Rust do by
//! themselves on the author's behalf, each begun and ended by id. While any
//! runs, the background-work plugin keeps the app going out of sight (a
//! foreground service on Android) or the computer awake; the diagnostics
//! page shows it (`work_running`, `work-changed`).

use crate::diagnostics::{self, Level};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_background_work::BackgroundWorkExt;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub id: String,
    pub title: String,
    /// When it began, in milliseconds since the epoch.
    pub since: i64,
}

#[derive(Default)]
pub struct Work {
    running: Mutex<Vec<Running>>,
    /// Held while the plugin is told what runs: one at a time, each telling what runs then.
    telling: Mutex<()>,
    /// What last stopped the work from running in the foreground, so it's noted once.
    last_problem: Mutex<Option<String>>,
}

/// What runs after `id` begins (or, already running, is renamed).
fn with_begun(mut running: Vec<Running>, id: &str, title: &str, now: i64) -> Vec<Running> {
    match running.iter_mut().find(|r| r.id == id) {
        Some(r) => r.title = title.to_string(),
        None => running.push(Running { id: id.to_string(), title: title.to_string(), since: now }),
    }
    running
}

impl Work {
    pub fn running(&self) -> Vec<Running> {
        self.running.lock().map(|r| r.clone()).unwrap_or_default()
    }

    // Spec: WORK-1
    /// `id` runs, as `title` says; beginning it again renames it.
    pub fn begin(&self, app: &AppHandle, id: &str, title: &str) {
        if let Ok(mut r) = self.running.lock() {
            *r = with_begun(std::mem::take(&mut *r), id, title, diagnostics::now_ms());
        }
        self.changed(app);
    }

    /// `id` is done (or failed); how long it took.
    pub fn end(&self, app: &AppHandle, id: &str) -> Option<i64> {
        let since = self.running.lock().ok().and_then(|mut r| {
            let i = r.iter().position(|x| x.id == id)?;
            Some(r.remove(i).since)
        });
        self.changed(app);
        since.map(|s| diagnostics::now_ms() - s)
    }

    // Spec: WORK-2, WORK-3
    /// Tells the plugin what runs now, off the calling thread (it waits on Android's main thread).
    fn changed(&self, app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let work = app.state::<Work>();
            let Ok(_telling) = work.telling.lock() else { return };
            let titles: Vec<String> = work.running().into_iter().map(|r| r.title).collect();
            let result = if titles.is_empty() { app.background_work().stop() } else { app.background_work().show(titles) };
            let problem = result.err().map(|e| e.to_string());
            if let Ok(mut last) = work.last_problem.lock() {
                if let Some(p) = &problem {
                    if last.as_deref() != Some(p.as_str()) {
                        diagnostics::report(&app, Level::Warning, "work", &format!("The work couldn't be kept running out of sight: {p}"));
                    }
                }
                *last = problem;
            }
            let _ = app.emit("work-changed", ());
        });
    }
}

/// "12 s", "3 min 5 s": how long something took, as the log says it.
pub fn took(ms: i64) -> String {
    let s = (ms + 500) / 1000;
    if s < 60 {
        format!("{s} s")
    } else {
        format!("{} min {} s", s / 60, s % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beginning_again_renames_and_keeps_the_start() {
        let r = with_begun(Vec::new(), "a", "Speaking a recording", 1);
        let r = with_begun(r, "b", "Answering", 2);
        let r = with_begun(r, "a", "Speaking “Attention”", 3);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0], Running { id: "a".into(), title: "Speaking “Attention”".into(), since: 1 });
    }

    #[test]
    fn durations_read_as_a_person_says_them() {
        assert_eq!(took(400), "0 s");
        assert_eq!(took(12_400), "12 s");
        assert_eq!(took(185_000), "3 min 5 s");
    }
}
