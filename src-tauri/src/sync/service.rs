//! Sync as the app runs it: listening for the book's other devices,
//! answering discovery, syncing soon after every change (and every minute
//! regardless), the computer's daily snapshots, and the commands the Sync
//! page calls. Events tell the frontend when data arrived (`sync-changed`)
//! and when the status moved (`sync-status`).

use crate::diagnostics::{self, Level};
use super::discovery;
use super::engine;
use super::session::{self, Outcome, PairingOffer, PairingSlot, Received};
use serde::Serialize;
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, OnceCell};

/// Syncs at least this often while the app runs, changes or not. The
/// computer asks often: the phone's own pushes may not reach it (a Mac
/// firewall turns away incoming connections to an unsigned app), so its
/// asking is what brings the phone's changes over. Idle syncs are cheap (no
/// full comparison when nothing moved). The phone asks less, for the battery.
const IDLE_ROUND: Duration = if cfg!(any(target_os = "android", target_os = "ios")) {
    Duration::from_secs(60)
} else {
    Duration::from_secs(10)
};
/// After a local change, wait this long for more before syncing.
const DEBOUNCE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub syncing: bool,
    pub last_error: Option<String>,
    pub last_round_at: Option<String>,
}

#[derive(Default)]
pub struct SyncService {
    pool: OnceCell<SqlitePool>,
    slot: PairingSlot,
    port: AtomicU16,
    started: AtomicBool,
    kick: Notify,
    activity: Mutex<Activity>,
    /// (book tag, device id) for answering discovery without the database.
    discovery_state: Arc<Mutex<Option<(String, String)>>>,
    /// The device, addresses and tag of the code last joined, for the connection check.
    last_join: Mutex<Option<(String, Vec<String>, String)>>,
    /// Why this device can't answer searches, if it can't.
    discovery_problem: Mutex<Option<String>>,
    /// Devices found nearby (mDNS), by device id: what they announced and when.
    nearby: Mutex<std::collections::HashMap<String, Nearby>>,
}

use super::now_iso;

/// A device found nearby (mDNS, `tauri-plugin-lan`).
#[derive(Debug, Clone)]
pub struct Nearby {
    pub name: String,
    pub book: String,
    pub pair: String,
    pub addrs: Vec<SocketAddr>,
    pub seen: std::time::Instant,
}

/// What a device announced, as the frontend passes it on (`sync_peer_found`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Announced {
    pub device_id: String,
    pub book: String,
    pub pair: String,
    pub addresses: Vec<String>,
    pub port: u16,
}

/// What this device announces nearby (`tauri-plugin-lan`'s config).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Announce {
    pub service_name: String,
    pub port: u16,
    pub device_id: String,
    pub book: String,
    pub pair: String,
}

/// How long a device found nearby is tried at what it announced.
const NEARBY_FOR: Duration = Duration::from_secs(10 * 60);

impl SyncService {
    fn set_activity(&self, app: &AppHandle, f: impl FnOnce(&mut Activity)) {
        let snapshot = {
            let mut a = self.activity.lock().expect("activity lock");
            f(&mut a);
            a.clone()
        };
        let _ = app.emit("sync-status", snapshot);
    }

    pub fn pool(&self) -> Result<&SqlitePool, String> {
        self.pool.get().ok_or_else(|| "sync hasn't started".into())
    }

    fn announce(&self, app: &AppHandle, outcome: &Outcome) {
        if outcome.received.changed_anything() {
            let _ = app.emit("sync-changed", outcome.received);
        }
        // Spec: DIAG-1
        // A sync that moved something, or ended with the devices differing, is noted.
        if outcome.received.changed_anything() || !outcome.complete {
            let level = if outcome.complete { Level::Info } else { Level::Warning };
            let differing = if outcome.complete { String::new() } else { format!("; still differing: {}", outcome.differences.join(", ")) };
            diagnostics::report(app, level, "sync", &format!("Synced with {}{}: took in {}{differing}", outcome.peer_name, at(outcome), describe(&outcome.received)));
        }
    }

    // Spec: DIAG-1
    /// Notes a sync failure, once until it changes.
    fn note_failure(&self, app: &AppHandle, error: &str) {
        let repeated = self.activity.lock().map(|a| a.last_error.as_deref() == Some(error)).unwrap_or(false);
        if !repeated {
            diagnostics::report(app, Level::Warning, "sync", &format!("Sync failed: {error}"));
        }
    }

    /// Starts listening and the sync loop, once. `pool` is the app's own.
    pub async fn start(self: &Arc<Self>, app: AppHandle, pool: SqlitePool) -> Result<(), String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.pool.set(pool.clone());
        session::identity(&pool).await?;

        // Incoming connections.
        let (svc, app2) = (self.clone(), app.clone());
        let (port, _) = session::listen(pool.clone(), self.slot.clone(), "0.0.0.0", move |r| match r {
            Ok(outcome) => {
                svc.announce(&app2, &outcome);
                svc.set_activity(&app2, |a| {
                    a.last_error = None;
                    a.last_round_at = Some(now_iso());
                });
            }
            Err(e) if e == "busy" || e == super::wire::CLOSED_UNOPENED => {}
            Err(e) => {
                diagnostics::report(&app2, Level::Warning, "sync", &format!("A device's sync with this one failed: {e}"));
            }
        })
        .await?;
        self.port.store(port, Ordering::SeqCst);

        // Spec: DIAG-2
        if port != session::PREFERRED_PORT {
            diagnostics::report(
                &app,
                Level::Warning,
                "sync",
                &format!("Sync listens on TCP port {port}: port {} is taken by another app (an earlier Commonplace still installed?).", session::PREFERRED_PORT),
            );
        }

        // Discovery answers.
        match discovery::bind_responder(discovery::PORT).await {
            Ok(socket) => {
                let state = self.discovery_state.clone();
                tokio::spawn(discovery::respond(socket, move || {
                    state.lock().ok()?.clone().map(|(tag, id)| (tag, id, port))
                }));
            }
            Err(e) => {
                let problem = format!("This device can't answer searches on UDP port {}: {e}", discovery::PORT);
                diagnostics::report(&app, Level::Error, "sync", &problem);
                if let Ok(mut d) = self.discovery_problem.lock() {
                    *d = Some(problem);
                }
            }
        }

        // The loop: soon after a change, and every minute anyway.
        let svc = self.clone();
        let app3 = app.clone();
        let loop_pool = pool.clone();
        tokio::spawn(async move {
            let pool = loop_pool;
            let mut last_seq = -1i64;
            let mut last_round = std::time::Instant::now() - IDLE_ROUND;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(DEBOUNCE) => {}
                    _ = svc.kick.notified() => { last_seq = -1; }
                }
                let Ok(state) = engine::local_state(&pool).await else { continue };
                if let (Some(book), Ok(mut d)) = (&state.book_id, svc.discovery_state.lock()) {
                    *d = Some((session::book_tag(book), state.device_id.clone()));
                }
                if state.book_id.is_none() {
                    continue;
                }
                if state.seq == last_seq && last_round.elapsed() < IDLE_ROUND {
                    continue;
                }
                last_round = std::time::Instant::now();
                svc.round(&app3, &pool).await;
                // Our own sync bumps seq (applied rows): re-read so that alone
                // doesn't trigger another round.
                last_seq = engine::local_state(&pool).await.map(|s| s.seq).unwrap_or(-1);
            }
        });

        // Spec: tandem.SYN-18
        // A desktop device keeps daily snapshots.
        if cfg!(not(any(target_os = "android", target_os = "ios"))) {
            if let Ok(dir) = app.path().app_data_dir() {
                let pool = pool.clone();
                let app_for_snapshots = app.clone();
                tokio::spawn(async move {
                    loop {
                        if let Err(e) = super::snapshots::run(&pool, &dir.join("snapshots"), &today()).await {
                            diagnostics::report(&app_for_snapshots, Level::Warning, "sync", &format!("The daily snapshot failed: {e}"));
                        }
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                    }
                });
            }
        }
        Ok(())
    }

    /// Finds the book's devices on the network and syncs with each.
    async fn round(&self, app: &AppHandle, pool: &SqlitePool) {
        self.set_activity(app, |a| a.syncing = true);
        let result = sync_round(pool, &self.nearby_of_book(pool).await).await;
        for o in result.outcomes.iter() {
            self.announce(app, o);
        }
        if let Some(e) = result.errors.first() {
            self.note_failure(app, e);
        }
        self.set_activity(app, |a| {
            a.syncing = false;
            a.last_round_at = Some(now_iso());
            a.last_error = result.errors.first().cloned();
        });
    }

    // Spec: tandem.SYN-23, DIAG-1
    /// Checks the connection, and notes what it found in the diagnostics.
    pub async fn check(&self, app: &AppHandle) -> Result<super::check::Report, String> {
        let pool = self.pool()?;
        let joining = self.last_join.lock().ok().and_then(|j| j.clone());
        let discovery = self.discovery_problem.lock().ok().and_then(|d| d.clone());
        let report = super::check::run(pool, self.port(), discovery, self.nearby(), joining).await;
        let fine = report.lines.iter().all(|l| l.ok != Some(false));
        let details: Vec<String> = report
            .lines
            .iter()
            .map(|l| format!("{} {}", match l.ok { Some(true) => "✓", Some(false) => "✗", None => "·" }, l.text))
            .collect();
        diagnostics::report_with(
            app,
            if fine { Level::Info } else { Level::Warning },
            "sync",
            &format!("Connection check: {}", report.verdict),
            Some(&details.join("\n")),
        );
        Ok(report)
    }

    // Spec: tandem.SYN-5
    /// What this device announces nearby: its sync port, its id, the book's
    /// tag and, while a code is on screen, the code's tag.
    pub async fn announcing(&self) -> Result<Option<Announce>, String> {
        let pool = self.pool()?;
        let port = self.port();
        if port == 0 {
            return Ok(None);
        }
        let me = session::identity(pool).await?;
        let pair = self
            .slot
            .lock()
            .ok()
            .and_then(|s| s.as_ref().filter(|p| p.expires > std::time::Instant::now()).map(|p| session::pair_tag(&p.token)))
            .unwrap_or_default();
        Ok(Some(Announce {
            service_name: format!("Commonplace-{}", me.device_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect::<String>()),
            port,
            device_id: me.device_id,
            book: me.book_id.as_deref().map(session::book_tag).unwrap_or_default(),
            pair,
        }))
    }

    // Spec: tandem.SYN-5
    /// A device found nearby: kept with every address it announced, and,
    /// when it's one of the book's, synced with now.
    pub async fn found_nearby(&self, peer: Announced) -> Result<(), String> {
        if peer.port == 0 || peer.addresses.len() > 32 || peer.device_id.is_empty() {
            return Err("an invalid nearby device".into());
        }
        let addrs: Vec<SocketAddr> = peer.addresses.iter().filter_map(|a| super::check::announced(a, peer.port)).collect();
        if addrs.is_empty() {
            return Ok(());
        }
        let pool = self.pool()?;
        let me = session::identity(pool).await?;
        if peer.device_id == me.device_id {
            return Ok(());
        }
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM book_devices WHERE id = ?").bind(&peer.device_id).fetch_optional(pool).await.ok().flatten();
        let ours = me.book_id.as_deref().map(session::book_tag).is_some_and(|t| t == peer.book);
        if let Ok(mut n) = self.nearby.lock() {
            if n.len() > 64 {
                n.retain(|_, v| v.seen.elapsed() < NEARBY_FOR);
            }
            n.insert(
                peer.device_id.clone(),
                Nearby { name: name.unwrap_or_else(|| peer.device_id.clone()), book: peer.book, pair: peer.pair, addrs, seen: std::time::Instant::now() },
            );
        }
        if ours {
            self.kick();
        }
        Ok(())
    }

    /// The book's devices found nearby lately, with their addresses.
    async fn nearby_of_book(&self, pool: &SqlitePool) -> Vec<(String, Vec<SocketAddr>)> {
        let tag = session::identity(pool).await.ok().and_then(|m| m.book_id).map(|b| session::book_tag(&b));
        let Some(tag) = tag else { return Vec::new() };
        self.nearby
            .lock()
            .map(|n| n.iter().filter(|(_, v)| v.book == tag && v.seen.elapsed() < NEARBY_FOR).map(|(k, v)| (k.clone(), v.addrs.clone())).collect())
            .unwrap_or_default()
    }

    /// Devices found nearby lately.
    pub fn nearby(&self) -> Vec<Nearby> {
        self.nearby.lock().map(|n| n.values().filter(|v| v.seen.elapsed() < NEARBY_FOR).cloned().collect()).unwrap_or_default()
    }

    /// Where the device showing the code with `tag` was found nearby, waiting up to `wait` for it.
    async fn showing(&self, tag: &str, wait: Duration) -> Vec<SocketAddr> {
        let until = std::time::Instant::now() + wait;
        loop {
            let found: Vec<SocketAddr> = self
                .nearby
                .lock()
                .map(|n| n.values().filter(|v| v.pair == tag && v.seen.elapsed() < NEARBY_FOR).flat_map(|v| v.addrs.clone()).collect())
                .unwrap_or_default();
            if !found.is_empty() || std::time::Instant::now() >= until {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub fn kick(&self) {
        self.kick.notify_one();
    }

    pub fn activity(&self) -> Activity {
        self.activity.lock().map(|a| a.clone()).unwrap_or_default()
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    pub async fn offer(&self) -> Result<String, String> {
        let pool = self.pool()?;
        let port = self.port();
        if port == 0 {
            return Err("sync isn't listening yet".into());
        }
        let addrs = session::local_addrs(port);
        if addrs.is_empty() {
            return Err("this device isn't on a local network".into());
        }
        let offer = session::offer(pool, &self.slot, addrs).await?;
        self.kick();
        Ok(offer.encode())
    }

    pub fn cancel_offer(&self) {
        if let Ok(mut s) = self.slot.lock() {
            *s = None;
        }
    }

    pub fn offer_active(&self) -> bool {
        self.slot
            .lock()
            .map(|s| s.as_ref().is_some_and(|p| p.expires > std::time::Instant::now()))
            .unwrap_or(false)
    }

    /// Joins the book behind `code`. With `replace`, a device that already
    /// holds data joins too: a complete copy of its database is saved in the
    /// app's `backups` folder first, and its path returned.
    pub async fn join(&self, app: &AppHandle, code: &str, replace: bool) -> Result<JoinResult, String> {
        let pool = self.pool()?;
        let offer = PairingOffer::decode(code)?;
        if let Ok(mut j) = self.last_join.lock() {
            *j = Some((offer.host_name.clone(), offer.addrs.clone(), session::pair_tag(&offer.token)));
        }
        let backup = if replace && !engine::data_tables(pool).await?.is_empty() {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
            Some(backup_before_join(pool, &dir).await?.to_string_lossy().into_owned())
        } else {
            None
        };
        self.set_activity(app, |a| a.syncing = true);
        // Spec: tandem.SYN-25
        // The device showing the code announces the code's tag nearby: wait a
        // moment to find it there, with every address it has.
        let found = self.showing(&session::pair_tag(&offer.token), Duration::from_secs(3)).await;
        let result = session::join(pool, &offer, &found, replace).await;
        match &result {
            Ok(o) => diagnostics::report(app, Level::Info, "sync", &format!("Joined the book through {}{}: took in {}", o.peer_name, at(o), describe(&o.received))),
            Err(e) => diagnostics::report(app, Level::Error, "sync", &format!("Joining a book failed: {e}")),
        }
        self.set_activity(app, |a| {
            a.syncing = false;
            a.last_error = result.as_ref().err().cloned();
            a.last_round_at = Some(now_iso());
        });
        if let Ok(o) = &result {
            // Everything changed: the frontend reloads whatever it shows.
            let _ = app.emit("sync-changed", o.received);
        }
        result.map(|outcome| JoinResult { outcome, backup })
    }
}

#[derive(Debug, Serialize)]
pub struct JoinResult {
    pub outcome: Outcome,
    /// Where the copy of this device's own data went, when it held any.
    pub backup: Option<String>,
}

/// Saves a complete copy of the database in `dir` before a join replaces
/// what's here — marked as a copy (instance.rs), so putting it back later is
/// noticed. Returns its path.
pub async fn backup_before_join(pool: &SqlitePool, dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp: String = now_iso().chars().filter(|c| c.is_ascii_digit()).take(14).collect();
    let path = dir.join(format!("book-before-join-{stamp}.db"));
    let _ = std::fs::remove_file(&path);
    let target = path.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{target}'")).execute(pool).await.map_err(|e| e.to_string())?;
    super::instance::mark_copy(&path).await?;
    Ok(path)
}

/// What one round found.
pub struct Round {
    pub outcomes: Vec<Outcome>,
    pub errors: Vec<String>,
}

/// One round: probe for the book's devices, then sync with each one found —
/// and with any known one that didn't answer, at the address it was last
/// reached at (a network that drops broadcasts still reaches it).
pub async fn sync_round(pool: &SqlitePool, nearby: &[(String, Vec<SocketAddr>)]) -> Round {
    let mut round = Round { outcomes: vec![], errors: vec![] };
    let Ok(me) = session::identity(pool).await else { return round };
    let Some(book) = me.book_id.clone() else { return round };
    let peers: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT d.id, p.last_addr FROM book_devices d LEFT JOIN sync_peers p ON p.device_id = d.id
         WHERE d.id <> ? AND d.public_key NOT IN (SELECT public_key FROM book_revocations)",
    )
    .bind(&me.device_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if peers.is_empty() {
        return round;
    }
    let last: Vec<String> = peers.iter().filter_map(|(_, a)| a.clone()).collect();
    let found = discovery::probe(
        &session::book_tag(&book),
        &me.device_id,
        &discovery::targets(&last, discovery::PORT),
        Duration::from_millis(800),
    )
    .await;
    for (id, last_addr) in &peers {
        // Where discovery says it is, then where it was last reached: an
        // answer to a probe isn't proof of anything (anyone on the network
        // can send one), so a failed attempt there doesn't end the search.
        // Spec: tandem.SYN-5
        // Every address it announced nearby (mDNS: IPv6 and IPv4), then
        // where the search found it, then where it was last reached; all
        // tried at once, the first to answer wins.
        let mut addrs: Vec<SocketAddr> = nearby.iter().filter(|(d, _)| d == id).flat_map(|(_, a)| a.iter().copied()).collect();
        addrs.extend(found.iter().filter(|f| &f.device_id == id).map(|f| f.addr));
        if let Some(a) = last_addr.as_ref().and_then(|a| a.parse::<SocketAddr>().ok()) {
            addrs.push(a);
        }
        let mut seen = Vec::new();
        addrs.retain(|a| if seen.contains(a) { false } else { seen.push(*a); true });
        if addrs.is_empty() {
            continue;
        }
        match session::sync_with(pool, &addrs).await {
            Ok(Some(o)) => round.outcomes.push(o),
            Ok(None) => {}
            // Not around is normal; anything else (macOS keeping the app
            // off the network, a stranger answering) is worth showing.
            Err(e) if !e.contains("Local Network")
                && (e.contains("no answer") || e.contains("refused") || e.contains("unreachable") || e.contains("doesn't answer")) => {}
            Err(e) => round.errors.push(e),
        }
    }
    round
}

/// " at 192.168.1.44:47832": where this device reached the other, when it did.
fn at(o: &Outcome) -> String {
    o.via.as_ref().map(|v| format!(" at {v}")).unwrap_or_default()
}

/// What a sync took in, as the diagnostics say it.
fn describe(r: &Received) -> String {
    format!("{} changes ({} were conflicts, {} merged rows)", r.applied + r.conflicts, r.conflicts, r.unique_merges)
}

/// Today's date (UTC), "YYYY-MM-DD".
pub fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0);
    super::civil_date(days)
}

// ---------------------------------------------------------------------------
// What the Sync page shows
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub is_self: bool,
    pub last_sync_at: Option<String>,
    pub last_complete_at: Option<String>,
    pub complete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub in_book: bool,
    pub devices: Vec<DeviceStatus>,
    /// True when this device holds none of the author's data, so it may join.
    pub can_join: bool,
    /// What it holds when it does: (table, rows).
    pub held: Vec<Held>,
    pub offer_active: bool,
    #[serde(flatten)]
    pub activity: Activity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub table: String,
    pub rows: i64,
}

pub async fn status(pool: &SqlitePool, svc: &SyncService) -> Result<Status, String> {
    let me = session::identity(pool).await?;
    let held: Vec<Held> = engine::held_data(pool)
        .await?
        .into_iter()
        .map(|(table, rows)| Held { table, rows })
        .collect();
    let rows: Vec<(String, String, String, Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT d.id, d.name, d.platform, p.last_sync_at, p.last_complete_at, p.complete
         FROM book_devices d LEFT JOIN sync_peers p ON p.device_id = d.id
         WHERE d.public_key NOT IN (SELECT public_key FROM book_revocations)
           -- One entry per key: a device that took a new id (instance.rs) is
           -- listed once, under the newest. This device is always its own.
           AND (d.id = ?1 OR NOT EXISTS (
             SELECT 1 FROM book_devices n WHERE n.public_key = d.public_key AND n.id <> d.id
               AND (n.added_at > d.added_at OR n.id = ?1)))
         ORDER BY d.added_at",
    )
    .bind(&me.device_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let devices = rows
        .into_iter()
        .map(|(id, name, platform, last_sync_at, last_complete_at, complete)| DeviceStatus {
            is_self: id == me.device_id,
            id,
            name,
            platform,
            last_sync_at,
            last_complete_at,
            complete: complete == Some(1),
        })
        .collect();
    Ok(Status {
        device_id: me.device_id,
        name: me.name,
        platform: me.platform,
        in_book: me.book_id.is_some(),
        devices,
        can_join: held.is_empty(),
        held,
        offer_active: svc.offer_active(),
        activity: svc.activity(),
    })
}

pub async fn set_name(pool: &SqlitePool, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err("a name of 1–60 characters".into());
    }
    sqlx::query(
        "INSERT INTO device_settings (key, value) VALUES ('sync_device_name', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(name)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let me = session::identity(pool).await?;
    sqlx::query("UPDATE book_devices SET name = ? WHERE id = ?")
        .bind(name)
        .bind(&me.device_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Takes a device out of the book: its key goes on the revocation list,
/// which only ever grows, so it's refused from then on everywhere the list
/// reaches — whatever later edits say about its entry. Its data stays where
/// it is.
pub async fn remove_device(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let me = session::identity(pool).await?;
    if id == me.device_id {
        return Err("a device can't remove itself".into());
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO book_revocations (public_key, device_id, revoked_at)
         SELECT public_key, id, ? FROM book_devices WHERE id = ?
         ON CONFLICT (public_key) DO NOTHING",
    )
    .bind(super::now_iso())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM book_devices WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}
