//! Lean on this computer, for the app: checks a block with Lean's language
//! server (LEAN-3), reads the proof state at a position (LEAN-4), writes each
//! verdict to `lean_checks` for every device to see (LEAN-5), verifies blocks
//! changed on another device by itself (LEAN-6), and sets up the workspace
//! (LEAN-8). One `lake serve` serves every check, one at a time.

use super::lsp::{uri_of, Lsp};
use super::model::{self, Block, Dep, Message};
use super::workspace::{self, Workspace};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

type Result<T> = std::result::Result<T, String>;

/// A first check imports Mathlib and builds what a block imports: it can take minutes.
const CHECK_WITHIN: Duration = Duration::from_secs(15 * 60);
const GOAL_WITHIN: Duration = Duration::from_secs(60);
const START_WITHIN: Duration = Duration::from_secs(120);
/// How often blocks changed elsewhere are looked for.
const BACKGROUND_EVERY: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct LeanService {
    server: tokio::sync::Mutex<Option<Server>>,
    setting_up: AtomicBool,
    background: AtomicBool,
    /// Hashes the background couldn't check (Lean failed, not the proof): not tried again.
    failed: Mutex<HashSet<String>>,
}

struct Server {
    lsp: Lsp,
    _child: tokio::process::Child,
    /// What Lean has open, by URI.
    docs: HashMap<String, Doc>,
    /// Each block's URI (a renamed block moves).
    uri_of_block: HashMap<String, String>,
}

struct Doc {
    version: i64,
    text: String,
    deps: Vec<Dep>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// elan's `lake`, when Lean is installed.
    pub lake: Option<String>,
    pub ready: bool,
    pub toolchain: Option<String>,
    pub setting_up: bool,
    pub workspace: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub block_id: String,
    pub status: String,
    pub messages: Vec<Message>,
    pub source_hash: String,
    pub deps: Vec<Dep>,
    pub lean_version: String,
    pub device: String,
    pub checked_at: String,
}

#[derive(Serialize)]
pub struct Goals {
    pub goals: Vec<String>,
    pub term: Option<String>,
}

pub fn workspace(app: &AppHandle) -> Result<Workspace> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(Workspace::new(dir.join("lean")))
}

/// The book's Lean blocks as stored: the name in the props, the source as the content.
async fn lean_blocks(pool: &SqlitePool) -> Result<Vec<Block>> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, props, content FROM blocks WHERE type = 'lean' AND deleted_at IS NULL")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, props, content)| {
            let name = serde_json::from_str::<Value>(&props)
                .ok()
                .and_then(|p| p.get("name").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            let source = serde_json::from_str::<Value>(&content)
                .ok()
                .and_then(|c| c.as_str().map(str::to_string))
                .unwrap_or_default();
            Block { id, name, source }
        })
        .collect())
}

// Spec: LEAN-5
async fn save(pool: &SqlitePool, v: &Verdict) -> Result<()> {
    sqlx::query(
        "INSERT INTO lean_checks (block_id, source_hash, deps, status, messages, lean_version, device, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (block_id) DO UPDATE SET
           source_hash = excluded.source_hash, deps = excluded.deps, status = excluded.status,
           messages = excluded.messages, lean_version = excluded.lean_version, device = excluded.device,
           checked_at = excluded.checked_at",
    )
    .bind(&v.block_id)
    .bind(&v.source_hash)
    .bind(serde_json::to_string(&v.deps).map_err(|e| e.to_string())?)
    .bind(&v.status)
    .bind(serde_json::to_string(&v.messages).map_err(|e| e.to_string())?)
    .bind(&v.lean_version)
    .bind(&v.device)
    .bind(&v.checked_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

impl LeanService {
    pub fn status(&self, app: &AppHandle) -> Result<Status> {
        let ws = workspace(app)?;
        Ok(Status {
            lake: workspace::find_lake().map(|p| p.to_string_lossy().into_owned()),
            ready: ws.is_ready(),
            toolchain: ws.toolchain(),
            setting_up: self.setting_up.load(Ordering::SeqCst),
            workspace: ws.dir.to_string_lossy().into_owned(),
        })
    }

    // Spec: LEAN-8
    /// Sets the workspace up in the background, telling the screens each line
    /// (`lean-setup` with `line`) and when it's done (`done`, `error`).
    pub fn set_up(self: Arc<Self>, app: AppHandle) -> Result<()> {
        let lake = workspace::find_lake().ok_or("Lean isn't installed on this computer: install elan first.")?;
        let ws = workspace(&app)?;
        if self.setting_up.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        tauri::async_runtime::spawn(async move {
            // The workspace changes under a running server: stop it.
            *self.server.lock().await = None;
            let a = app.clone();
            let on_line = move |line: String| {
                let _ = a.emit("lean-setup", json!({ "line": line }));
            };
            let result = workspace::set_up(&ws, &lake, &on_line).await;
            self.setting_up.store(false, Ordering::SeqCst);
            let _ = app.emit("lean-setup", json!({ "done": true, "error": result.err() }));
        });
        Ok(())
    }

    /// The running server, started (`lake serve`) if it isn't.
    async fn server_in<'a>(guard: &'a mut Option<Server>, ws: &Workspace) -> Result<&'a mut Server> {
        if guard.as_ref().is_some_and(|s| s.lsp.is_closed()) {
            *guard = None;
        }
        if guard.is_none() {
            let lake = workspace::find_lake().ok_or("Lean isn't installed on this computer")?;
            let mut child = workspace::lake(&lake, &ws.dir, &["serve"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("couldn't start Lean: {e}"))?;
            let stdin = child.stdin.take().ok_or("Lean has no input")?;
            let stdout = child.stdout.take().ok_or("Lean has no output")?;
            let lsp = Lsp::new(stdout, stdin);
            lsp.request(
                "initialize",
                json!({ "processId": std::process::id(), "rootUri": uri_of(&ws.dir), "capabilities": {} }),
                START_WITHIN,
            )
            .await?;
            lsp.notify("initialized", json!({})).await?;
            *guard = Some(Server { lsp, _child: child, docs: HashMap::new(), uri_of_block: HashMap::new() });
        }
        guard.as_mut().ok_or_else(|| "Lean didn't start".to_string())
    }

    /// Puts the block (as `name` and `source`, saved or not) in its file and in
    /// front of Lean. Returns its URI, the version Lean has, and what it imports.
    async fn open(server: &mut Server, ws: &Workspace, pool: &SqlitePool, block_id: &str, name: &str, source: &str) -> Result<(String, i64, Vec<Dep>)> {
        let mut blocks = lean_blocks(pool).await?;
        match blocks.iter_mut().find(|b| b.id == block_id) {
            Some(b) => {
                b.name = name.to_string();
                b.source = source.to_string();
            }
            None => blocks.push(Block { id: block_id.into(), name: name.into(), source: source.into() }),
        }
        let index = model::by_name(&blocks);
        ws.write_modules(&index)?;
        let owns = index.get(name).is_some_and(|b| b.id == block_id);
        let path = if owns { ws.module_path(name) } else { ws.write_scratch(block_id, source)? };
        let uri = uri_of(&path);
        let deps = model::deps_of(source, &index);

        // Renamed: the old file is no longer this block's.
        if let Some(old) = server.uri_of_block.insert(block_id.to_string(), uri.clone()) {
            if old != uri && server.docs.remove(&old).is_some() {
                server.lsp.notify("textDocument/didClose", json!({ "textDocument": { "uri": old } })).await?;
            }
        }
        let lsp = &server.lsp;
        if let Some(doc) = server.docs.get_mut(&uri) {
            if doc.deps == deps {
                if doc.text != source {
                    doc.version += 1;
                    doc.text = source.to_string();
                    lsp.notify(
                        "textDocument/didChange",
                        json!({ "textDocument": { "uri": uri, "version": doc.version }, "contentChanges": [{ "text": source }] }),
                    )
                    .await?;
                }
                return Ok((uri, doc.version, deps));
            }
        }
        // New to Lean, or what it imports changed: opened afresh, so Lean builds the imports again.
        let version = match server.docs.remove(&uri) {
            Some(doc) => {
                lsp.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } })).await?;
                doc.version + 1
            }
            None => 1,
        };
        lsp.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "lean4", "version": version, "text": source } }))
            .await?;
        server.docs.insert(uri.clone(), Doc { version, text: source.to_string(), deps: deps.clone() });
        Ok((uri, version, deps))
    }

    fn ready(app: &AppHandle) -> Result<Workspace> {
        let ws = workspace(app)?;
        if ws.is_ready() {
            Ok(ws)
        } else {
            Err("Lean isn't set up on this computer (Settings → Lean).".into())
        }
    }

    // Spec: LEAN-3, LEAN-5
    /// Checks a block as `source`, saves the verdict, and returns it.
    pub async fn check(&self, app: &AppHandle, block_id: &str, name: &str, source: &str) -> Result<Verdict> {
        let ws = Self::ready(app)?;
        let pool = crate::db_pool(app).await?;
        let (messages, deps) = {
            let mut guard = self.server.lock().await;
            let server = Self::server_in(&mut guard, &ws).await?;
            let (uri, version, deps) = Self::open(server, &ws, &pool, block_id, name, source).await?;
            server.lsp.request("textDocument/waitForDiagnostics", json!({ "uri": uri, "version": version }), CHECK_WITHIN).await?;
            let messages: Vec<Message> = server.lsp.diagnostics(&uri, version).iter().filter_map(model::message_of).collect();
            (messages, deps)
        };
        let me = crate::sync::session::identity(&pool).await?;
        let verdict = Verdict {
            block_id: block_id.to_string(),
            status: model::status_of(&messages).to_string(),
            source_hash: model::hash(name, source),
            deps,
            lean_version: ws.toolchain().unwrap_or_default(),
            device: me.name,
            checked_at: crate::sync::now_iso(),
            messages,
        };
        save(&pool, &verdict).await?;
        let _ = app.emit("lean-checked", json!({ "blockId": block_id }));
        Ok(verdict)
    }

    // Spec: LEAN-4
    /// The proof state at a position in a block (as `source`): its goals, or
    /// the expected type of the term there.
    pub async fn goal(&self, app: &AppHandle, block_id: &str, name: &str, source: &str, line: u32, character: u32) -> Result<Option<Goals>> {
        let ws = Self::ready(app)?;
        let pool = crate::db_pool(app).await?;
        let mut guard = self.server.lock().await;
        let server = Self::server_in(&mut guard, &ws).await?;
        let (uri, _, _) = Self::open(server, &ws, &pool, block_id, name, source).await?;
        let at = json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": character } });
        let plain = server.lsp.request("$/lean/plainGoal", at.clone(), GOAL_WITHIN).await?;
        let goals: Vec<String> = plain
            .get("goals")
            .and_then(Value::as_array)
            .map(|g| g.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let term = if goals.is_empty() {
            server
                .lsp
                .request("$/lean/plainTermGoal", at, GOAL_WITHIN)
                .await
                .ok()
                .and_then(|t| t.get("goal").and_then(Value::as_str).map(str::to_string))
        } else {
            None
        };
        Ok(if goals.is_empty() && term.is_none() { None } else { Some(Goals { goals, term }) })
    }

    /// Starts looking for blocks changed elsewhere, once.
    pub fn start_background(self: Arc<Self>, app: AppHandle) {
        if self.background.swap(true, Ordering::SeqCst) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(BACKGROUND_EVERY).await;
                if let Err(e) = self.verify_changed(&app).await {
                    eprintln!("lean: {e}");
                }
            }
        });
    }

    // Spec: LEAN-6
    /// Checks the Lean blocks another device changed whose verdict no longer
    /// holds. Blocks changed here are checked as they're edited.
    async fn verify_changed(&self, app: &AppHandle) -> Result<()> {
        if self.setting_up.load(Ordering::SeqCst) || Self::ready(app).is_err() {
            return Ok(());
        }
        let pool = crate::db_pool(app).await?;
        let me = crate::sync::session::identity(&pool).await?.device_id;
        let blocks = lean_blocks(&pool).await?;
        let index = model::by_name(&blocks);
        let checks: Vec<(String, String, String)> = sqlx::query_as("SELECT block_id, source_hash, deps FROM lean_checks")
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;
        let held: HashMap<String, (String, Vec<Dep>)> = checks
            .into_iter()
            .map(|(id, hash, deps)| (id, (hash, serde_json::from_str(&deps).unwrap_or_default())))
            .collect();
        let origins: HashMap<String, String> = sqlx::query_as(
            "SELECT pk, origin FROM sync_rows WHERE tbl = 'blocks' AND pk IN (SELECT id FROM blocks WHERE type = 'lean')",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
        for b in &blocks {
            let hash = model::hash(&b.name, &b.source);
            let deps = model::deps_of(&b.source, &index);
            let holds = held.get(&b.id).is_some_and(|(h, d)| *h == hash && *d == deps);
            let elsewhere = origins.get(&b.id).is_some_and(|o| *o != me);
            let tried = self.failed.lock().map(|f| f.contains(&hash)).unwrap_or(false);
            if holds || !elsewhere || tried {
                continue;
            }
            if let Err(e) = self.check(app, &b.id, &b.name, &b.source).await {
                eprintln!("lean: couldn't check {}: {e}", b.id);
                if let Ok(mut f) = self.failed.lock() {
                    f.insert(hash);
                }
            }
        }
        Ok(())
    }
}
