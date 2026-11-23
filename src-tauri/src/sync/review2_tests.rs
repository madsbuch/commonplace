//! Regression tests from the second adversarial review: a database restored
//! as a whole folder (marker file and all), and edits made on such a copy
//! before its first sync. Both reproduced data loss or permanent divergence
//! against the first fix, and guard the second (session epochs, and version
//! vectors that hold clock values rather than counts).

use super::session::{self, PairingSlot};
use super::tests::{device, exec, Device};
use super::{engine, instance};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn text_of(pool: &SqlitePool, id: &str) -> String {
    sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?").bind(id).fetch_one(pool).await.unwrap()
}

/// A listening host P, and a phone D paired with it whose database has been
/// checked in place (marker + file beside it), as the app does at start.
async fn book() -> (Device, SocketAddr, Device, PathBuf) {
    let host = device().await;
    let slot: PairingSlot = Default::default();
    let (port, _) = session::listen(host.pool.clone(), slot.clone(), "127.0.0.1", |_| {}).await.unwrap();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let offer = session::offer(&host.pool, &slot, vec![addr.to_string()]).await.unwrap();
    let phone = device().await;
    let path = phone._dir.0.join("book.db");
    instance::check(&phone.pool, &path).await.unwrap();
    session::join(&phone.pool, &offer, &[], false).await.unwrap();
    (host, addr, phone, path)
}

async fn sync(pool: &SqlitePool, addr: SocketAddr) -> Result<session::Outcome, String> {
    for _ in 0..100 {
        if let Some(o) = session::sync_with(pool, &[addr]).await? {
            return Ok(o);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Err("busy".into())
}

/// The app's data folder copied as a whole — database AND the marker file
/// beside it — as Time Machine, Migration Assistant, a restored home folder
/// or any file-level backup does. Returns the restored database's path.
async fn folder_copy(pool: &SqlitePool, db: &Path, into: &crate::test_db::Scratch) -> PathBuf {
    let target = into.0.join("book.db");
    sqlx::query(&format!("VACUUM INTO '{}'", target.display())).execute(pool).await.unwrap();
    let mut side = db.as_os_str().to_owned();
    side.push(".instance");
    let mut side_to = target.as_os_str().to_owned();
    side_to.push(".instance");
    std::fs::copy(PathBuf::from(side), PathBuf::from(side_to)).unwrap();
    target
}

async fn open(path: &Path) -> SqlitePool {
    SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(path)).await.unwrap()
}

// ---------------------------------------------------------------------------
// R1. A folder-level restore passes the marker check; an edit made before
//     the Seen check catches it reuses a version counter → permanent split.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_edit_made_on_a_restored_copy_before_its_first_sync_still_converges() {
    let (host, addr, phone, path) = book().await;
    exec(&phone.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('x', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    sync(&phone.pool, addr).await.unwrap();

    let backup_dir = crate::test_db::Scratch::new();
    let backup = folder_copy(&phone.pool, &path, &backup_dir).await;

    // The phone edits the block and writes a little more; it all syncs.
    exec(&phone.pool, "UPDATE blocks SET content = 'Draft, revised' WHERE id = 'x'").await;
    exec(&phone.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('y', 'paragraph', 'a0', 'Note', 'now', 'now')").await;
    sync(&phone.pool, addr).await.unwrap();

    // Restored from the folder backup. The marker check runs first, as in the app…
    let restored = open(&backup).await;
    assert_eq!(instance::check(&restored, &backup).await.unwrap(), instance::Check::Same, "marker can't tell");
    // …then, before the first sync, the author corrects the same block.
    exec(&restored, "UPDATE blocks SET content = 'Draft, corrected' WHERE id = 'x'").await;

    // First sync: Seen catches the restore and rotates. Then sync until quiet.
    let first = sync(&restored, addr).await;
    assert!(first.as_ref().is_err_and(|e| e.contains("older copy")), "{first:?}");
    for _ in 0..3 {
        let _ = sync(&restored, addr).await;
    }
    let (on_host, on_phone) = (text_of(&host.pool, "x").await, text_of(&restored, "x").await);
    let (dh, dp) = (engine::digest(&host.pool).await.unwrap(), engine::digest(&restored).await.unwrap());
    eprintln!("host: {on_host:?}; restored phone: {on_phone:?}; differing: {:?}", engine::digest_differences(&dh, &dp));
    assert_eq!(on_host, on_phone, "two versions with the same counter never reconcile");
}

// ---------------------------------------------------------------------------
// R2. ... and if the restored copy writes more than the gap before its first
//     sync, Seen doesn't fire at all: the gap's writes never leave it.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_restored_copy_that_writes_a_lot_before_syncing_is_still_caught() {
    let (host, addr, phone, path) = book().await;
    sync(&phone.pool, addr).await.unwrap();
    let backup_dir = crate::test_db::Scratch::new();
    let backup = folder_copy(&phone.pool, &path, &backup_dir).await;
    for i in 0..3 {
        exec(&phone.pool, &format!("INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('before-loss-{i}', 'paragraph', 'a0', 'x', 'now', 'now')")).await;
    }
    sync(&phone.pool, addr).await.unwrap();

    let restored = open(&backup).await;
    assert_eq!(instance::check(&restored, &backup).await.unwrap(), instance::Check::Same);
    // A day offline (the laptop away from home): ten blocks.
    for i in 0..10 {
        exec(&restored, &format!("INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('offline-{i}', 'paragraph', 'a0', 'x', 'now', 'now')")).await;
    }
    for _ in 0..3 {
        let r = sync(&restored, addr).await;
        eprintln!("sync: {:?}", r.map(|o| o.complete));
    }
    let arrived = count(&host.pool, "SELECT count(*) FROM blocks WHERE id LIKE 'offline-%'").await;
    let back = count(&restored, "SELECT count(*) FROM blocks WHERE id LIKE 'before-loss-%'").await;
    eprintln!("offline blocks on the host: {arrived}/10; pre-restore blocks back on the phone: {back}/3");
    assert_eq!(arrived, 10, "blocks written on the restored copy never reach the host");
    assert_eq!(back, 3);
}

// R3 (a column added by a later migration missing from the update trigger's
// list) is guarded by "every update trigger watches every column of its
// table" in tests/sync-tracking.test.ts, which fails for any table left so.
