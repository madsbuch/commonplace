//! Making a recording (AUD-5, AUD-6, AUD-7, AUD-13). A recording is made as
//! it's listened to: a worker per recording keeps `audio.lead` ahead of where
//! the listener is (`listen`: from the web view's player on a computer, from
//! the native player's state on Android, asked here every few seconds so it
//! goes on with the app in the background), writing a chunk of the script
//! when it's reached (script.rs) and speaking its passages a few at once, each
//! a piece of its own: Opus in WebM in `recording_pieces`, which syncs, so
//! nothing is made twice and any device plays what's made. Paused, it stops
//! once the lead is made. `make_all` makes the rest at once instead, on the
//! device that asked, carrying on when the app starts again.
//!
//! On Android, Rust also sets what the native player plays (the made pieces
//! around where it starts, a file each) and adds pieces to it as they're made.

use super::encode::{resample, OpusStream};
use super::plan::{self, Next, PieceKey, Script, Slot};
use super::script as writer;
use super::speech::speak;
use crate::diagnostics::{self, Level};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_audio_player::{AudioPlayerExt, Queue, QueueItem};
use tauri_plugin_http::reqwest;
use tokio::sync::Notify;

type Result<T> = std::result::Result<T, String>;

/// Passages spoken at once.
const PARALLEL: usize = 3;
// Spec: WORK-4
/// Seconds to wait before each try again when the network fails: three minutes
/// in all (`work.network-patience`). A refusal that won't change is tried once
/// more; an answer that can't be read, twice.
const NETWORK_WAITS: [u64; 7] = [2, 5, 10, 20, 30, 45, 68];
const REFUSED_WAITS: [u64; 1] = [2];
const UNUSABLE_WAITS: [u64; 2] = [1, 2];
/// With nothing to make, a worker waits this long for the listener to move on, then stops.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// How often, while the native player has a recording, Rust asks it where it is.
const POLL: Duration = Duration::from_secs(3);
/// How often, while playing, where the native player is is kept.
const SAVE_EVERY: Duration = Duration::from_secs(10);

/// What a recording's worker is to make.
#[derive(Clone)]
struct Target {
    /// Where the listener is; the start when not known.
    from: Option<PieceKey>,
    /// All of it at once (AUD-13), not just ahead of the listener.
    all: bool,
    /// When it last changed.
    at: Instant,
    wake: Arc<Notify>,
}

/// What the native player has: a recording's pieces up to `last`.
struct Native {
    recording: String,
    last: Option<PieceKey>,
}

#[derive(Default)]
pub struct AudioService {
    targets: Mutex<HashMap<String, Target>>,
    running: Mutex<HashSet<String>>,
    native: Mutex<Option<Native>>,
    polling: Mutex<bool>,
    /// Held while a recording's script is written back.
    scripts: tokio::sync::Mutex<()>,
}

/// A passage's key: the model, the voice and the text.
pub fn clip_key(model: &str, voice: &str, text: &str) -> String {
    hex::encode(Sha256::digest(format!("{model}\u{1}{voice}\u{1}{text}").as_bytes()))
}

/// A TypeID for a ledger row, time-ordered as the app's own are.
fn ledger_id() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut b: [u8; 16] = rand::random();
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = 0x70 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    crate::type_id::type_id("ai_usage", b)
}

fn work_id(id: &str) -> String {
    format!("audio:{id}")
}

async fn set_status(pool: &SqlitePool, id: &str, status: &str, error: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE recordings SET status = ?, error = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(error)
        .bind(crate::sync::now_iso())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn setting(pool: &SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?").bind(key).fetch_optional(pool).await.ok().flatten().filter(|v| !v.trim().is_empty())
}

async fn api_key(pool: &SqlitePool) -> Result<String> {
    setting(pool, "openrouter_api_key").await.ok_or_else(|| "There's no OpenRouter key (Settings → AI and models).".to_string())
}

/// A recording as the maker needs it.
struct Row {
    title: String,
    voice: String,
    model: String,
    status: String,
    script: Option<Script>,
}

async fn row(pool: &SqlitePool, id: &str) -> Result<Option<Row>> {
    let r: Option<(String, String, String, String, Option<String>)> = sqlx::query_as("SELECT title, voice, speech_model, status, script FROM recordings WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let Some((title, voice, model, status, script)) = r else { return Ok(None) };
    let script = match script {
        Some(s) => Some(serde_json::from_str::<Script>(&s).map_err(|e| format!("its script can't be read: {e}"))?),
        None => None,
    };
    Ok(Some(Row { title, voice, model, status, script }))
}

/// The pieces made of a recording, and their lengths.
async fn made(pool: &SqlitePool, id: &str) -> Result<HashMap<PieceKey, f64>> {
    let rows: Vec<(String, f64)> = sqlx::query_as("SELECT id, seconds FROM recording_pieces WHERE recording_id = ?").bind(id).fetch_all(pool).await.map_err(|e| e.to_string())?;
    Ok(rows.into_iter().filter_map(|(piece, s)| PieceKey::parse(&piece, id).map(|k| (k, s))).collect())
}

/// Whether a recording was made before, at once, as one file (only those have a length of their own).
async fn kept_as_file(pool: &SqlitePool, id: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM recordings WHERE id = ? AND duration_seconds IS NOT NULL").bind(id).fetch_optional(pool).await.ok().flatten().is_some()
}

/// Where a recording's pieces are written as files, for Android's player.
fn pieces_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recordings").join(safe))
}

/// Writes `bytes` to `path` unless it's there already: beside it, then moved, so a player never sees half a file.
fn write_once(path: &PathBuf, bytes: &[u8]) -> Result<()> {
    if std::fs::metadata(path).map(|m| m.len()).ok() == Some(bytes.len() as u64) {
        return Ok(());
    }
    let part = path.with_extension("webm.part");
    std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&part, path).map_err(|e| e.to_string())
}

// Spec: AUD-10
/**
 * A recording made before as one file, as a file for Android's player
 * (Media3 plays files, not bytes): written to the app's data folder once,
 * and again if it changed.
 */
pub async fn file_path(app: &AppHandle, pool: &SqlitePool, id: &str) -> Result<String> {
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT data FROM recording_files WHERE recording_id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("this recording hasn't reached this device yet")?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    let path = dir.join(format!("{safe}.webm"));
    write_once(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Pieces as files, for Android's player.
async fn piece_files(app: &AppHandle, pool: &SqlitePool, id: &str, keys: &[PieceKey]) -> Result<Vec<QueueItem>> {
    let dir = pieces_dir(app, id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for k in keys {
        let piece = k.id(id);
        let path = dir.join(format!("{piece}.webm"));
        if !path.exists() {
            let bytes: Vec<u8> = sqlx::query_scalar("SELECT data FROM recording_pieces WHERE id = ?").bind(&piece).fetch_one(pool).await.map_err(|e| e.to_string())?;
            write_once(&path, &bytes)?;
        }
        out.push(QueueItem { id: piece, path: path.to_string_lossy().into_owned() });
    }
    Ok(out)
}

/// A passage spoken (tried again while the network fails), as PCM at `SAMPLE_RATE`; logged in the ledger.
async fn spoken(app: &AppHandle, pool: &SqlitePool, client: &reqwest::Client, key: &str, model: &str, voice: &str, text: &str) -> Result<Vec<i16>> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match speak(client, key, model, voice, text).await {
            Ok(speech) => {
                // Spec: AUD-5
                // OpenRouter doesn't price speech: the ledger counts its characters.
                sqlx::query("INSERT INTO ai_usage (id, feature, model, prompt_tokens, completion_tokens, cost, created_at) VALUES (?, 'speech', ?, ?, 0, 0, ?)")
                    .bind(ledger_id())
                    .bind(model)
                    .bind(text.chars().count() as i64)
                    .bind(crate::sync::now_iso())
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(resample(&speech.pcm, speech.rate));
            }
            Err(e) => {
                let waits: &[u64] = if e.transient { &NETWORK_WAITS } else { &REFUSED_WAITS };
                let Some(wait) = waits.get(attempt - 1) else { return Err(e.message) };
                // Spec: DIAG-1
                let preview: String = text.chars().take(80).collect();
                diagnostics::report_with(
                    app,
                    Level::Warning,
                    "audio",
                    &format!("Speaking a passage failed (try {attempt}); trying again in {wait} s: {}", e.message),
                    Some(&format!("model {model}, voice {voice}, {} characters: \"{preview}…\"", text.chars().count())),
                );
                tokio::time::sleep(Duration::from_secs(*wait)).await;
            }
        }
    }
}

/// What a piece is made of.
struct PieceJob {
    key: PieceKey,
    text: String,
    first: bool,
    pause: f64,
}

// Spec: AUD-7
/// Speaks a passage and keeps it as a piece: Opus in WebM, its pauses included.
async fn make_piece(app: &AppHandle, pool: &SqlitePool, client: &reqwest::Client, key: &str, (model, voice, id, title): (&str, &str, &str, &str), job: PieceJob) -> Result<()> {
    // A passage a recording made before had spoken already isn't paid for again.
    let clip = clip_key(model, voice, &job.text);
    let kept: Option<Vec<u8>> = sqlx::query_scalar("SELECT pcm FROM speech_clips WHERE key = ?").bind(&clip).fetch_optional(pool).await.map_err(|e| e.to_string())?;
    let pcm: Vec<i16> = match kept {
        Some(bytes) => bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect(),
        None => spoken(app, pool, client, key, model, voice, &job.text).await?,
    };
    let named = title.to_string();
    let (webm, seconds) = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, f64)> {
        let mut s = OpusStream::new()?;
        if job.first {
            s.silence(plan::LEAD_IN)?;
        }
        s.push(&pcm)?;
        s.silence(job.pause)?;
        let (webm, seconds, _) = s.finish(&named)?;
        Ok((webm, seconds))
    })
    .await
    .map_err(|e| e.to_string())??;
    sqlx::query("INSERT OR REPLACE INTO recording_pieces (id, recording_id, chapter, chunk, passage, seconds, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(job.key.id(id))
        .bind(id)
        .bind(job.key.chapter as i64)
        .bind(job.key.chunk as i64)
        .bind(job.key.passage as i64)
        .bind(seconds)
        .bind(webm)
        .bind(crate::sync::now_iso())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let _ = sqlx::query("DELETE FROM speech_clips WHERE key = ?").bind(&clip).execute(pool).await;
    Ok(())
}

impl AudioService {
    fn target(&self, id: &str) -> Option<Target> {
        self.targets.lock().ok()?.get(id).cloned()
    }

    /// Sets what `id`'s worker is to make, keeping what isn't said; wakes it.
    fn aim(&self, id: &str, from: Option<Option<PieceKey>>, all: Option<bool>) {
        let Ok(mut targets) = self.targets.lock() else { return };
        let t = targets.entry(id.to_string()).or_insert_with(|| Target { from: None, all: false, at: Instant::now(), wake: Arc::new(Notify::new()) });
        if let Some(f) = from {
            t.from = f;
        }
        if let Some(a) = all {
            t.all = a;
        }
        t.at = Instant::now();
        t.wake.notify_one();
    }

    fn spawn(self: &Arc<Self>, app: &AppHandle, id: &str) {
        let fresh = self.running.lock().map(|mut r| r.insert(id.to_string())).unwrap_or(false);
        if !fresh {
            return;
        }
        let (me, app, id) = (self.clone(), app.clone(), id.to_string());
        tauri::async_runtime::spawn(async move {
            let result = me.make(&app, &id).await;
            let took = app.state::<crate::work::Work>().end(&app, &work_id(&id)).map(crate::work::took).unwrap_or_default();
            match &result {
                Ok(Some(title)) => diagnostics::report(&app, Level::Info, "audio", &format!("Finished: Making “{title}” ({took})")),
                Ok(None) => {}
                Err(e) => {
                    diagnostics::report_with(&app, Level::Error, "audio", &format!("Failed: Making a recording: {e}"), Some(&format!("recording {id}")));
                    if let Ok(pool) = crate::db_pool(&app).await {
                        let all = me.target(&id).is_some_and(|t| t.all);
                        let status: Option<String> = sqlx::query_scalar("SELECT status FROM recordings WHERE id = ?").bind(&id).fetch_optional(&pool).await.ok().flatten();
                        // Made at once, it failed; made as it's listened to, it says why and plays what's made.
                        let next = if all { "failed" } else { status.as_deref().unwrap_or("listening") };
                        let _ = set_status(&pool, &id, next, Some(e)).await;
                    }
                    if let Ok(mut t) = me.targets.lock() {
                        t.remove(&id);
                    }
                }
            }
            if let Ok(mut r) = me.running.lock() {
                r.remove(&id);
            }
            let _ = app.emit("audio-changed", json!({ "id": id }));
        });
    }

    // Spec: AUD-6
    /// The listener is at `piece` of `id` (its start when not known): make ahead of there.
    pub fn listen(self: &Arc<Self>, app: &AppHandle, id: &str, piece: Option<&str>) {
        let from = piece.and_then(|p| PieceKey::parse(p, id));
        self.aim(id, Some(from), None);
        self.spawn(app, id);
    }

    // Spec: AUD-13
    /// Makes all of `id` that isn't made, at once, on this device.
    pub async fn make_all(self: &Arc<Self>, app: &AppHandle, id: &str) -> Result<()> {
        let pool = crate::db_pool(app).await?;
        let me = crate::sync::session::identity(&pool).await?.device_id;
        sqlx::query("UPDATE recordings SET status = 'making', error = NULL, device = ?, updated_at = ? WHERE id = ?")
            .bind(me)
            .bind(crate::sync::now_iso())
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        self.aim(id, None, Some(true));
        self.spawn(app, id);
        let _ = app.emit("audio-changed", json!({ "id": id }));
        Ok(())
    }

    /// A recording deleted: its worker stops, and its files go.
    pub fn forget(&self, app: &AppHandle, id: &str) {
        if let Ok(mut t) = self.targets.lock() {
            if let Some(t) = t.remove(id) {
                t.wake.notify_one();
            }
        }
        if let Ok(mut n) = self.native.lock() {
            if n.as_ref().is_some_and(|n| n.recording == id) {
                *n = None;
            }
        }
        if let Ok(dir) = pieces_dir(app, id) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // Spec: AUD-6, AUD-13
    /**
     * When the app starts: this device's recordings being made at once carry
     * on, and so do those it was speaking at once before recordings were made
     * as they're listened to.
     */
    pub async fn resume(self: Arc<Self>, app: AppHandle) -> Result<()> {
        let pool = crate::db_pool(&app).await?;
        let me = crate::sync::session::identity(&pool).await?.device_id;
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM recordings WHERE status IN ('making', 'speaking') AND device = ?")
            .bind(me)
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for id in ids {
            self.make_all(&app, &id).await?;
        }
        Ok(())
    }

    /// Makes what `id`'s target wants until it's made; then waits for the listener to move on. Its title, once all of it is made.
    async fn make(self: &Arc<Self>, app: &AppHandle, id: &str) -> Result<Option<String>> {
        let pool = crate::db_pool(app).await?;
        // Connections left idle go stale when the phone sleeps: they're not reused for long.
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .pool_idle_timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let mut working = false;
        let mut shown = -1.0;
        loop {
            let Some(target) = self.target(id) else { return Ok(None) };
            let Some(rec) = row(&pool, id).await? else { return Ok(None) };
            // A recording made before as one file is made (here or on its way).
            if rec.status == "ready" && kept_as_file(&pool, id).await {
                return Ok(None);
            }
            // The app is still preparing its script.
            if rec.status == "writing" {
                if target.at.elapsed() > IDLE {
                    return Ok(None);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            let Some(script) = rec.script else { return Err("its script was never prepared: try again".into()) };
            let slots = plan::slots(&script);
            let made = made(&pool, id).await?;
            let progress = plan::progress(&slots, &made);
            if (progress - shown).abs() > 0.001 {
                shown = progress;
                sqlx::query("UPDATE recordings SET progress = ? WHERE id = ?").bind(progress).bind(id).execute(&pool).await.map_err(|e| e.to_string())?;
                let _ = app.emit("audio-progress", json!({ "id": id, "progress": progress }));
            }
            let lead = (!target.all).then_some(plan::LEAD_SECONDS);
            let from = if target.all { None } else { target.from };
            let next = plan::next(&slots, &made, from.as_ref(), lead, PARALLEL);
            if !matches!(next, Next::Nothing) && !working {
                working = true;
                let what = if target.all { "Making" } else { "Making ahead" };
                app.state::<crate::work::Work>().begin(app, &work_id(id), &format!("{what}: “{}”", rec.title));
                if rec.status == "failed" {
                    set_status(&pool, id, if target.all { "making" } else { "listening" }, None).await?;
                }
            }
            match next {
                Next::Write { chapter, chunk } => self.write_chunk(app, &pool, &client, id, chapter, chunk).await?,
                Next::Speak(keys) => {
                    let key = api_key(&pool).await?;
                    let jobs: Vec<PieceJob> = slots
                        .iter()
                        .filter_map(|s| match s {
                            Slot::Piece { key, text, first, pause } if keys.contains(key) => Some(PieceJob { key: *key, text: text.clone(), first: *first, pause: *pause }),
                            _ => None,
                        })
                        .collect();
                    let (pool_ref, client_ref, key_ref) = (&pool, &client, key.as_str());
                    let names = (rec.model.as_str(), rec.voice.as_str(), id, rec.title.as_str());
                    let results: Vec<Result<()>> =
                        futures_util::stream::iter(jobs.into_iter().map(|job| make_piece(app, pool_ref, client_ref, key_ref, names, job))).buffer_unordered(PARALLEL).collect().await;
                    for k in &keys {
                        let _ = app.emit("audio-piece", json!({ "id": id, "piece": k.id(id) }));
                    }
                    if let Some(Err(e)) = results.into_iter().find(Result::is_err) {
                        return Err(e);
                    }
                    if rec.status == "listening" || rec.status == "making" {
                        sqlx::query("UPDATE recordings SET error = NULL WHERE id = ? AND error IS NOT NULL").bind(id).execute(&pool).await.map_err(|e| e.to_string())?;
                    }
                    self.extend_native(app, &pool, id).await;
                }
                Next::Nothing => {
                    if plan::complete(&slots, &made) {
                        // Listened to again once all of it is made: nothing to say.
                        if rec.status == "ready" {
                            return Ok(None);
                        }
                        sqlx::query("UPDATE recordings SET status = 'ready', progress = 1, error = NULL, updated_at = ? WHERE id = ?")
                            .bind(crate::sync::now_iso())
                            .bind(id)
                            .execute(&pool)
                            .await
                            .map_err(|e| e.to_string())?;
                        return Ok(Some(rec.title));
                    }
                    if working {
                        working = false;
                        app.state::<crate::work::Work>().end(app, &work_id(id));
                    }
                    // Wait for the listener to move on; with no word for a while, stop.
                    let seen = target.at;
                    if tokio::time::timeout(IDLE, target.wake.notified()).await.is_err() {
                        let mut running = self.running.lock().map_err(|e| e.to_string())?;
                        if self.target(id).is_none_or(|t| t.at <= seen) {
                            running.remove(id);
                            // Its spawner removes it again: harmless.
                            drop(running);
                            return Ok(None);
                        }
                    }
                }
            }
        }
    }

    // Spec: AUD-3, AUD-5
    /// Writes a chunk of `id`'s script (tried again while the network fails), logged in the ledger, and keeps it.
    async fn write_chunk(&self, app: &AppHandle, pool: &SqlitePool, client: &reqwest::Client, id: &str, chapter: usize, chunk: usize) -> Result<()> {
        let key = api_key(pool).await?;
        let model = setting(pool, "audio_script_model").await.unwrap_or_else(|| writer::DEFAULT_SCRIPT_MODEL.to_string());
        let source = row(pool, id)
            .await?
            .and_then(|r| r.script)
            .and_then(|s| s.chapters.get(chapter).and_then(|c| c.chunks.as_ref()?.get(chunk).and_then(|k| k.source.clone())))
            .ok_or("the chunk to write isn't in the script")?;
        let (mut network, mut unusable) = (0usize, 0usize);
        let written = loop {
            match writer::write(client, &key, &model, &source).await {
                Ok(w) => break w,
                Err(e) => {
                    let wait = if e.transient {
                        network += 1;
                        NETWORK_WAITS.get(network - 1)
                    } else if e.unusable {
                        unusable += 1;
                        UNUSABLE_WAITS.get(unusable - 1)
                    } else {
                        None
                    };
                    let Some(wait) = wait else { return Err(e.message) };
                    // Spec: DIAG-1
                    diagnostics::report(app, Level::Warning, "audio", &format!("Writing a passage of a recording's script failed; trying again in {wait} s: {}", e.message));
                    tokio::time::sleep(Duration::from_secs(*wait)).await;
                }
            }
        };
        // Spec: AI-3
        sqlx::query("INSERT INTO ai_usage (id, feature, model, prompt_tokens, completion_tokens, cost, created_at) VALUES (?, 'audio_script', ?, ?, ?, ?, ?)")
            .bind(ledger_id())
            .bind(&model)
            .bind(written.prompt_tokens)
            .bind(written.completion_tokens)
            .bind(written.cost)
            .bind(crate::sync::now_iso())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        let passages = plan::passages(&written.paragraphs);
        // Read again and written back at once: nothing else of the script is lost.
        let _held = self.scripts.lock().await;
        let mut script = row(pool, id).await?.and_then(|r| r.script).ok_or("the recording went")?;
        if let Some(k) = script.chapters.get_mut(chapter).and_then(|c| c.chunks.as_mut()).and_then(|c| c.get_mut(chunk)) {
            k.passages = Some(passages);
        }
        sqlx::query("UPDATE recordings SET script = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&script).map_err(|e| e.to_string())?)
            .bind(crate::sync::now_iso())
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        let _ = app.emit("audio-changed", json!({ "id": id }));
        Ok(())
    }

    // Spec: AUD-10
    /**
     * Has Android's player play `id` from `piece` (a recording made before as
     * one file when None), `position` seconds into it: the made pieces around
     * it, a file each. Then keeps asking the player where it is, to make ahead
     * and add pieces as they're made.
     */
    pub async fn play_native(self: &Arc<Self>, app: &AppHandle, id: &str, piece: Option<&str>, position: f64, play: bool, speed: f64) -> Result<()> {
        let pool = crate::db_pool(app).await?;
        let title: String = sqlx::query_scalar("SELECT title FROM recordings WHERE id = ?").bind(id).fetch_optional(&pool).await.map_err(|e| e.to_string())?.ok_or("no such recording")?;
        let queue = match piece {
            None => {
                let chapters: Option<String> = sqlx::query_scalar("SELECT chapters FROM recordings WHERE id = ?").bind(id).fetch_one(&pool).await.map_err(|e| e.to_string())?;
                let starts = chapters
                    .and_then(|c| serde_json::from_str::<Vec<serde_json::Value>>(&c).ok())
                    .map(|cs| cs.iter().filter_map(|c| c.get("start").and_then(serde_json::Value::as_f64)).collect())
                    .unwrap_or_default();
                let path = file_path(app, &pool, id).await?;
                Queue { items: vec![QueueItem { id: id.to_string(), path }], index: 0, position, play, speed, title, starts }
            }
            Some(p) => {
                let at = PieceKey::parse(p, id).ok_or("not one of this recording's pieces")?;
                let script = row(&pool, id).await?.and_then(|r| r.script).ok_or("the recording has no script yet")?;
                let slots = plan::slots(&script);
                let made = made(&pool, id).await?;
                let (keys, index) = plan::run_around(&slots, &made, &at);
                if keys.is_empty() {
                    return Err("that part isn't made yet".into());
                }
                let items = piece_files(app, &pool, id, &keys).await?;
                if let Ok(mut n) = self.native.lock() {
                    *n = Some(Native { recording: id.to_string(), last: keys.last().copied() });
                }
                Queue { items, index, position, play, speed, title, starts: Vec::new() }
            }
        };
        let player = app.clone();
        tauri::async_runtime::spawn_blocking(move || player.audio_player().set_queue(&queue)).await.map_err(|e| e.to_string())??;
        if piece.is_none() {
            if let Ok(mut n) = self.native.lock() {
                *n = Some(Native { recording: id.to_string(), last: None });
            }
        }
        self.poll_native(app);
        Ok(())
    }

    /// Adds `id`'s pieces made since to Android's player, if it has `id`.
    async fn extend_native(&self, app: &AppHandle, pool: &SqlitePool, id: &str) {
        let last = match self.native.lock() {
            Ok(n) => match n.as_ref() {
                Some(Native { recording, last: Some(last) }) if recording == id => *last,
                _ => return,
            },
            Err(_) => return,
        };
        let Ok(Some(script)) = row(pool, id).await.map(|r| r.and_then(|r| r.script)) else { return };
        let Ok(made) = made(pool, id).await else { return };
        let keys = plan::run_after(&plan::slots(&script), &made, &last);
        if keys.is_empty() {
            return;
        }
        let Ok(items) = piece_files(app, pool, id, &keys).await else { return };
        let player = app.clone();
        let added = tauri::async_runtime::spawn_blocking(move || player.audio_player().extend_queue(&items)).await;
        if matches!(added, Ok(Ok(()))) {
            if let Ok(mut n) = self.native.lock() {
                if let Some(n) = n.as_mut().filter(|n| n.recording == id) {
                    n.last = keys.last().copied();
                }
            }
        }
    }

    // Spec: AUD-6, AUD-9
    /// While Android's player has a recording, asks it where it is: to make ahead of there, and to keep where it was left.
    fn poll_native(self: &Arc<Self>, app: &AppHandle) {
        {
            let Ok(mut p) = self.polling.lock() else { return };
            if *p {
                return;
            }
            *p = true;
        }
        let (me, app) = (self.clone(), app.clone());
        tauri::async_runtime::spawn(async move {
            let mut saved: Option<(String, f64, Instant)> = None;
            loop {
                tokio::time::sleep(POLL).await;
                let Some(recording) = me.native.lock().ok().and_then(|n| n.as_ref().map(|n| n.recording.clone())) else { break };
                let player = app.clone();
                let Ok(Ok(state)) = tauri::async_runtime::spawn_blocking(move || player.audio_player().state()).await else { continue };
                if state.id.is_empty() {
                    if let Ok(mut n) = me.native.lock() {
                        *n = None;
                    }
                    break;
                }
                let piece = (plan::recording_of(&state.id) == Some(recording.as_str())).then(|| state.id.clone());
                if piece.is_none() && state.id != recording {
                    continue;
                }
                if let Some(p) = &piece {
                    me.listen(&app, &recording, Some(p));
                }
                // Spec: AUD-9
                let due = saved.as_ref().is_none_or(|(id, pos, at)| *id != state.id || ((pos - state.position).abs() > 0.5 && (at.elapsed() >= SAVE_EVERY || !state.playing)));
                if due {
                    if let Ok(pool) = crate::db_pool(&app).await {
                        let _ = sqlx::query(
                            "INSERT INTO listening (recording_id, position, piece, updated_at) VALUES (?, ?, ?, ?)
                             ON CONFLICT (recording_id) DO UPDATE SET position = excluded.position, piece = excluded.piece, updated_at = excluded.updated_at",
                        )
                        .bind(&recording)
                        .bind(state.position)
                        .bind(piece.as_deref())
                        .bind(crate::sync::now_iso())
                        .execute(&pool)
                        .await;
                        saved = Some((state.id.clone(), state.position, Instant::now()));
                    }
                }
            }
            if let Ok(mut p) = me.polling.lock() {
                *p = false;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_passage_is_known_by_model_voice_and_text() {
        let a = clip_key("m", "Charon", "Attention.");
        assert_eq!(a, clip_key("m", "Charon", "Attention."));
        assert_ne!(a, clip_key("m", "Kore", "Attention."));
        assert_ne!(a, clip_key("other", "Charon", "Attention."));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn ledger_ids_are_typeids_in_time_order() {
        let a = ledger_id();
        std::thread::sleep(Duration::from_millis(2));
        let b = ledger_id();
        assert!(a.starts_with("ai_usage_") && a.len() == "ai_usage_".len() + 26);
        assert!(a < b);
    }

    #[test]
    fn the_lead_is_the_specs() {
        let spec: serde_json::Value = serde_json::from_str(include_str!("../../../.spec/library/audio.json")).unwrap();
        let lead = spec["values"].as_array().unwrap().iter().find(|v| v["id"] == "audio.lead").unwrap()["value"].as_str().unwrap().to_string();
        assert_eq!(lead, format!("{}min", plan::LEAD_SECONDS as u64 / 60));
    }
}
