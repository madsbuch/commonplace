//! What happened on the native side, for the diagnostics (DIAG-1, DIAG-2):
//! failures of sync, recordings and Lean, the work Rust does by itself, and
//! a crash, written to the `diagnostics` table the frontend shows and copies
//! (src/lib/diagnostics.ts writes the frontend's own).
//!
//! Entries wait in memory until the database is open (the frontend opens it,
//! running the migrations), then go in. A panic can't count on the
//! database, so the panic hook appends a line to a file beside it, taken in
//! at the next start (`take_crashes`).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
    Error,
    Warning,
    Info,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warning => "warning",
            Level::Info => "info",
        }
    }
}

struct Entry {
    at: i64,
    level: Level,
    source: String,
    message: String,
    details: Option<String>,
}

static PENDING: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

/// The file a crash is written to, beside the database.
pub const CRASH_FILE: &str = "crashes.jsonl";
/// Longest message and details kept, in characters.
const MOST_MESSAGE: usize = 2_000;
const MOST_DETAILS: usize = 20_000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn cut(s: &str, most: usize) -> String {
    if s.chars().count() <= most {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(most).collect();
        out.push('…');
        out
    }
}

// Spec: DIAG-5
/// `s` with anything shaped like an OpenRouter key (or a bearer token) masked.
pub fn mask(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let next = [("sk-or-", "sk-or-"), ("Bearer ", "Bearer ")]
            .iter()
            .filter_map(|(needle, keep)| rest.find(needle).map(|i| (i, needle.len(), *keep)))
            .min_by_key(|(i, _, _)| *i);
        let Some((i, len, keep)) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..i]);
        out.push_str(keep);
        let after = &rest[i + len..];
        let token = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')).unwrap_or(after.len());
        if token > 0 {
            out.push('…');
        }
        rest = &after[token..];
    }
}

// Spec: DIAG-1, DIAG-2
/// Notes what happened, with more to it in `details`.
pub fn report_with(app: &AppHandle, level: Level, source: &str, message: &str, details: Option<&str>) {
    report_at(app, now_ms(), level, source, message, details);
}

fn report_at(app: &AppHandle, at: i64, level: Level, source: &str, message: &str, details: Option<&str>) {
    eprintln!("{source}: {message}");
    let entry = Entry {
        at,
        level,
        source: source.to_string(),
        message: cut(&mask(message), MOST_MESSAGE),
        details: details.map(|d| cut(&mask(d), MOST_DETAILS)),
    };
    if let Ok(mut pending) = PENDING.lock() {
        pending.push(entry);
    }
    flush(app.clone());
}

/// Notes what happened.
pub fn report(app: &AppHandle, level: Level, source: &str, message: &str) {
    report_with(app, level, source, message, None);
}

/// Writes what's waiting, once the database is open; tells the screens.
pub fn flush(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(pool) = crate::db_pool(&app).await else { return };
        let entries: Vec<Entry> = match PENDING.lock() {
            Ok(mut pending) => std::mem::take(&mut *pending),
            Err(_) => return,
        };
        if entries.is_empty() {
            return;
        }
        for e in entries {
            let _ = sqlx::query("INSERT INTO diagnostics (at, level, source, message, details) VALUES (?, ?, ?, ?, ?)")
                .bind(e.at)
                .bind(e.level.as_str())
                .bind(&e.source)
                .bind(&e.message)
                .bind(&e.details)
                .execute(&pool)
                .await;
        }
        let _ = app.emit("diagnostics-changed", ());
    });
}

/// A crash, as the panic hook writes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Crash {
    pub at: i64,
    pub thread: String,
    pub message: String,
    pub location: String,
    pub backtrace: String,
}

// Spec: DIAG-2
/// From now on, a panic is written to `dir/crashes.jsonl` (and then handled as before).
pub fn install_panic_hook(dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic without a message".to_string());
        let crash = Crash {
            at: now_ms(),
            thread: std::thread::current().name().unwrap_or("unnamed").to_string(),
            message: mask(&message),
            location: info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default(),
            backtrace: cut(&std::backtrace::Backtrace::force_capture().to_string(), 8_000),
        };
        let _ = write_crash(&dir, &crash);
        previous(info);
    }));
}

fn write_crash(dir: &Path, crash: &Crash) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let line = serde_json::to_string(crash).map_err(std::io::Error::other)?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(CRASH_FILE))?;
    writeln!(f, "{line}")
}

/// The crashes written to `dir`, oldest first; the file is gone after.
pub fn read_crashes(dir: &Path) -> Vec<Crash> {
    let path = dir.join(CRASH_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let _ = std::fs::remove_file(&path);
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

// Spec: DIAG-2
/// Takes in the crashes since the app last ran.
pub fn take_crashes(app: &AppHandle, dir: &Path) {
    for c in read_crashes(dir) {
        let details = format!("thread {} at {}\n{}", c.thread, c.location, c.backtrace);
        // Kept at the time it happened, not now.
        report_at(app, c.at, Level::Error, "crash", &format!("The app's native side crashed: {}", c.message), Some(&details));
    }
}

/// An error with what caused it, all the way down: reqwest's "error sending
/// request" alone says nothing of why.
pub fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let m = s.to_string();
        if !out.contains(&m) {
            out.push_str(": ");
            out.push_str(&m);
        }
        source = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_masked() {
        assert_eq!(mask("key sk-or-v1-0123abcd, then"), "key sk-or-…, then");
        assert_eq!(mask("Authorization: Bearer abc.def-123 and sk-or-x"), "Authorization: Bearer … and sk-or-…");
        assert_eq!(mask("nothing here"), "nothing here");
    }

    #[test]
    fn a_crash_is_read_once() {
        let dir = std::env::temp_dir().join(format!("commonplace-crash-{}", now_ms()));
        let crash = Crash { at: 5, thread: "main".into(), message: "boom".into(), location: "a.rs:1:2".into(), backtrace: String::new() };
        write_crash(&dir, &crash).unwrap();
        write_crash(&dir, &crash).unwrap();
        assert_eq!(read_crashes(&dir), vec![crash.clone(), crash]);
        assert!(read_crashes(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[derive(Debug)]
    struct Outer(Inner);
    #[derive(Debug)]
    struct Inner;
    impl std::fmt::Display for Outer {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(f, "error sending request")
        }
    }
    impl std::fmt::Display for Inner {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(f, "dns error: no such host")
        }
    }
    impl std::error::Error for Inner {}
    impl std::error::Error for Outer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn an_error_says_what_caused_it() {
        assert_eq!(chain(&Outer(Inner)), "error sending request: dns error: no such host");
    }
}
