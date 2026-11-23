//! Making a recording's audio (AUD-5, AUD-6, AUD-7): its script, written by
//! the app (src/lib/audio.ts), spoken a passage at a time through OpenRouter,
//! three at once, each passage kept in `speech_clips` (this device only) as
//! it arrives; then all of it, with pauses, into one Opus stream in WebM,
//! stored in `recording_files` (which syncs), the chapters and length on the
//! recording. A job that stops carries on from its clips: nothing is spoken
//! twice. Only the device that made a recording carries on with it.

use super::encode::{resample, OpusStream, SAMPLE_RATE};
use super::speech::speak;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_http::reqwest;

type Result<T> = std::result::Result<T, String>;

/// Passages spoken at once.
const PARALLEL: usize = 3;
/// Tries per passage before the recording is given up on.
const TRIES: usize = 3;
const LEAD_IN: f64 = 0.4;
const BETWEEN_PARAGRAPHS: f64 = 0.45;
const BETWEEN_CHAPTERS: f64 = 1.2;

#[derive(Debug, Deserialize)]
struct Script {
    chapters: Vec<ScriptChapter>,
}

#[derive(Debug, Deserialize)]
struct ScriptChapter {
    title: String,
    paragraphs: Vec<String>,
}

#[derive(Default)]
pub struct AudioService {
    running: Mutex<HashSet<String>>,
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

async fn set_status(pool: &SqlitePool, id: &str, status: &str, progress: f64, error: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE recordings SET status = ?, progress = ?, error = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(progress)
        .bind(error)
        .bind(crate::sync::now_iso())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn api_key(pool: &SqlitePool) -> Result<String> {
    let key: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'openrouter_api_key'")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    key.filter(|k| !k.trim().is_empty()).ok_or_else(|| "There's no OpenRouter key (Settings → AI and models).".to_string())
}

/// Speaks a passage unless it's been spoken already; logs it in the ledger.
async fn clip(pool: &SqlitePool, client: &reqwest::Client, key: &str, model: &str, voice: &str, text: &str) -> Result<()> {
    let k = clip_key(model, voice, text);
    let have: Option<i64> = sqlx::query_scalar("SELECT 1 FROM speech_clips WHERE key = ?").bind(&k).fetch_optional(pool).await.map_err(|e| e.to_string())?;
    if have.is_some() {
        return Ok(());
    }
    let mut last = String::new();
    for attempt in 0..TRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2 * attempt as u64 + 1)).await;
        }
        match speak(client, key, model, voice, text).await {
            Ok(speech) => {
                let pcm = resample(&speech.pcm, speech.rate);
                let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
                sqlx::query("INSERT OR REPLACE INTO speech_clips (key, sample_rate, pcm, created_at) VALUES (?, ?, ?, ?)")
                    .bind(&k)
                    .bind(i64::from(SAMPLE_RATE))
                    .bind(bytes)
                    .bind(crate::sync::now_iso())
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
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
                return Ok(());
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

impl AudioService {
    // Spec: AUD-6
    /// Makes (or carries on making) a recording's audio, in the background, once.
    pub fn render(self: Arc<Self>, app: AppHandle, id: String) {
        if let Ok(mut r) = self.running.lock() {
            if !r.insert(id.clone()) {
                return;
            }
        }
        tauri::async_runtime::spawn(async move {
            let result = run(&app, &id).await;
            if let Err(e) = &result {
                eprintln!("audio: {id}: {e}");
                if let Ok(pool) = crate::db_pool(&app).await {
                    let _ = set_status(&pool, &id, "failed", 0.0, Some(e)).await;
                }
            }
            if let Ok(mut r) = self.running.lock() {
                r.remove(&id);
            }
            let _ = app.emit("audio-changed", json!({ "id": id }));
        });
    }

    // Spec: AUD-6
    /// Carries on with this device's recordings that were being spoken when the app stopped.
    pub async fn resume(self: Arc<Self>, app: AppHandle) -> Result<()> {
        let pool = crate::db_pool(&app).await?;
        let me = crate::sync::session::identity(&pool).await?.device_id;
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM recordings WHERE status = 'speaking' AND device = ?")
            .bind(me)
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for id in ids {
            self.clone().render(app.clone(), id);
        }
        Ok(())
    }
}

async fn run(app: &AppHandle, id: &str) -> Result<()> {
    let pool = crate::db_pool(app).await?;
    let (title, voice, model, script): (String, String, String, Option<String>) =
        sqlx::query_as("SELECT title, voice, speech_model, script FROM recordings WHERE id = ?")
            .bind(id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such recording")?;
    let script: Script = serde_json::from_str(&script.ok_or("the recording has no script yet")?).map_err(|e| format!("its script can't be read: {e}"))?;
    let key = api_key(&pool).await?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(180)).build().map_err(|e| e.to_string())?;

    // Every passage spoken (or found spoken), a few at a time.
    let passages: Vec<String> = script.chapters.iter().flat_map(|c| c.paragraphs.iter().cloned()).filter(|p| !p.trim().is_empty()).collect();
    let total = passages.len().max(1);
    let done = Arc::new(AtomicUsize::new(0));
    set_status(&pool, id, "speaking", 0.0, None).await?;
    let jobs = passages.iter().cloned().map(|text| {
        let (pool, client, key, model, voice, done, app, id) =
            (pool.clone(), client.clone(), key.clone(), model.clone(), voice.clone(), done.clone(), app.clone(), id.to_string());
        async move {
            let r = clip(&pool, &client, &key, &model, &voice, &text).await;
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            // Speaking is most of the work: progress runs to 0.95 here.
            let progress = 0.95 * n as f64 / total as f64;
            let _ = set_status(&pool, &id, "speaking", progress, None).await;
            let _ = app.emit("audio-progress", json!({ "id": id, "progress": progress }));
            r
        }
    });
    let results: Vec<Result<()>> = futures_util::stream::iter(jobs).buffer_unordered(PARALLEL).collect().await;
    if let Some(Err(e)) = results.into_iter().find(Result::is_err) {
        return Err(e);
    }

    // All of it, in order, with pauses, into one stream.
    let mut stream = OpusStream::new()?;
    stream.silence(LEAD_IN)?;
    for (ci, chapter) in script.chapters.iter().enumerate() {
        if ci > 0 {
            stream.silence(BETWEEN_CHAPTERS)?;
        }
        stream.chapter(&chapter.title);
        for (pi, text) in chapter.paragraphs.iter().filter(|p| !p.trim().is_empty()).enumerate() {
            if pi > 0 {
                stream.silence(BETWEEN_PARAGRAPHS)?;
            }
            let bytes: Vec<u8> = sqlx::query_scalar("SELECT pcm FROM speech_clips WHERE key = ?")
                .bind(clip_key(&model, &voice, text))
                .fetch_one(&pool)
                .await
                .map_err(|e| e.to_string())?;
            let pcm: Vec<i16> = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
            stream.push(&pcm)?;
        }
    }
    let (webm, seconds, chapters) = tauri::async_runtime::spawn_blocking(move || stream.finish(&title)).await.map_err(|e| e.to_string())??;
    let chapters: Vec<serde_json::Value> = chapters.iter().map(|c| json!({ "title": c.title, "start": c.start_ms as f64 / 1000.0 })).collect();

    sqlx::query("INSERT OR REPLACE INTO recording_files (recording_id, media_type, data) VALUES (?, 'audio/webm', ?)")
        .bind(id)
        .bind(webm)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE recordings SET status = 'ready', progress = 1, error = NULL, chapters = ?, duration_seconds = ?, updated_at = ? WHERE id = ?")
        .bind(serde_json::to_string(&chapters).map_err(|e| e.to_string())?)
        .bind(seconds)
        .bind(crate::sync::now_iso())
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    // Its passages aren't needed any more.
    for text in &passages {
        let _ = sqlx::query("DELETE FROM speech_clips WHERE key = ?").bind(clip_key(&model, &voice, text)).execute(&pool).await;
    }
    Ok(())
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
    fn scripts_read_as_the_app_writes_them() {
        let s: Script = serde_json::from_str(r#"{"chapters":[{"title":"1 Introduction","paragraphs":["One.","Two."]}]}"#).unwrap();
        assert_eq!(s.chapters[0].paragraphs.len(), 2);
    }
}
