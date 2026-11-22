//! Regression tests from an adversarial review of sync. Each one reproduced a
//! real bug (data loss, divergence, a removed device coming back) against the
//! first version, and guards the fix now.

use super::engine;
use super::tests::{device, exec, insert_block, synced_test_table};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

/// Both directions, then orphan cleanup on both sides — what one session does.
async fn session(a: &SqlitePool, b: &SqlitePool) {
    engine::pull_all(a, b, 500, 4 << 20).await.unwrap();
    engine::pull_all(b, a, 500, 4 << 20).await.unwrap();
    engine::remove_orphans(a).await.unwrap();
    engine::remove_orphans(b).await.unwrap();
}

async fn settle(devices: &[&SqlitePool]) {
    for _ in 0..6 {
        for (i, a) in devices.iter().enumerate() {
            for (j, b) in devices.iter().enumerate() {
                if i != j {
                    session(a, b).await;
                }
            }
        }
    }
}

/// One pull of a single one-row batch: a connection that dropped after it.
async fn pull_one_row(into: &SqlitePool, from: &SqlitePool) {
    let into_id = engine::local_state(into).await.unwrap().device_id;
    let from_id = engine::local_state(from).await.unwrap().device_id;
    let since = engine::pulled_from(into, &from_id).await.unwrap();
    let batch = engine::export(from, since, &into_id, 1, 1 << 20).await.unwrap();
    engine::apply(into, &from_id, &batch).await.unwrap();
}

// ---------------------------------------------------------------------------
// 1. remove_orphans after an interrupted pull deletes a child everywhere
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_interrupted_pull_then_a_session_with_a_third_device_keeps_the_child() {
    let (a, b, c) = (device().await, device().await, device().await);
    // A parent and a child that cascades with it (the app's own tables have
    // no such reference; sync must still get it right).
    for d in [&a, &b, &c] {
        synced_test_table(&d.pool, "parents", "text").await;
        synced_test_table(&d.pool, "kids", "text REFERENCES parents(key) ON DELETE CASCADE").await;
    }
    settle(&[&a.pool, &b.pool, &c.pool]).await;

    // On A: a parent, its child, then the parent is edited, so the
    // parent's newest version sits *after* the child in A's log.
    exec(&a.pool, "INSERT INTO parents (key, value) VALUES ('d', 'Labs')").await;
    exec(&a.pool, "INSERT INTO kids (key, value) VALUES ('f', 'd')").await;
    exec(&a.pool, "UPDATE parents SET value = 'Labs, November' WHERE key = 'd'").await;

    // B pulls one batch from A (the child, not the parent) and the
    // connection drops: no orphan cleanup, the session failed.
    pull_one_row(&b.pool, &a.pool).await;
    assert_eq!(count(&b.pool, "SELECT count(*) FROM kids").await, 1);
    assert_eq!(count(&b.pool, "SELECT count(*) FROM parents WHERE key = 'd'").await, 0);

    // B then completes an ordinary session with C, which ends in remove_orphans.
    session(&b.pool, &c.pool).await;

    // Everyone syncs with everyone until nothing moves.
    settle(&[&a.pool, &b.pool, &c.pool]).await;

    // The parent survives everywhere, and so must its child.
    assert_eq!(count(&a.pool, "SELECT count(*) FROM parents WHERE key = 'd'").await, 1);
    assert_eq!(
        count(&a.pool, "SELECT count(*) FROM kids WHERE value = 'd'").await,
        1,
        "the child was deleted on the device that created it"
    );
}

#[tokio::test]
async fn a_child_added_while_its_parent_was_deleted_elsewhere_goes_too() {
    let (a, b) = (device().await, device().await);
    for d in [&a, &b] {
        synced_test_table(&d.pool, "parents", "text").await;
        synced_test_table(&d.pool, "kids", "text REFERENCES parents(key) ON DELETE CASCADE").await;
    }
    exec(&a.pool, "INSERT INTO parents (key, value) VALUES ('d', 'x')").await;
    settle(&[&a.pool, &b.pool]).await;
    exec(&a.pool, "DELETE FROM parents WHERE key = 'd'").await;
    exec(&b.pool, "INSERT INTO kids (key, value) VALUES ('f', 'd')").await;
    settle(&[&a.pool, &b.pool]).await;
    for d in [&a, &b] {
        assert_eq!(count(&d.pool, "SELECT count(*) FROM kids").await, 0);
    }
}

// ---------------------------------------------------------------------------
// 2. A device restored from an older copy of its own database
// ---------------------------------------------------------------------------

/// A copy of `d`'s database as it is now (what Android Auto Backup, a
/// device-to-device transfer, or putting back one of the computer's daily
/// snapshots hands back later).
async fn copy_of(d: &SqlitePool, dir: &crate::test_db::Scratch) -> std::path::PathBuf {
    let path = dir.0.join("copy.db");
    sqlx::query(&format!("VACUUM INTO '{}'", path.display())).execute(d).await.unwrap();
    path
}

#[tokio::test]
async fn a_device_restored_from_an_older_copy_takes_a_new_id_and_catches_up() {
    let (a, b) = (device().await, device().await);
    // As the app does every time it opens its database.
    super::instance::check(&b.pool, &b._dir.0.join("book.db")).await.unwrap();
    exec(&b.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('old', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    session(&a.pool, &b.pool).await;

    let dir = crate::test_db::Scratch::new();
    let backup = copy_of(&b.pool, &dir).await;

    // After the backup, B keeps logging and syncing as usual.
    for i in 0..5 {
        exec(&b.pool, &format!("INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('after-backup-{i}', 'paragraph', 'a0', 'x', 'now', 'now')")).await;
    }
    session(&a.pool, &b.pool).await;

    // The phone is reset and restored from the backup: same device id, same
    // key, older seq. The author writes three blocks on it.
    let restored = SqlitePoolOptions::new()
        .connect_with(SqliteConnectOptions::new().filename(&backup))
        .await
        .unwrap();
    let b2 = restored;
    assert_eq!(engine::local_state(&b2).await.unwrap().device_id, b.id);
    // What the app does on opening a database, before anything is written:
    // this one wasn't written here, so it takes a new id.
    assert!(matches!(
        super::instance::check(&b2, &backup).await.unwrap(),
        super::instance::Check::Rotated { .. }
    ));
    for i in 0..3 {
        exec(&b2, &format!("INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('new-{i}', 'paragraph', 'a0', 'Second', 'now', 'now')")).await;
    }
    settle(&[&a.pool, &b2]).await;

    let on_a = count(&a.pool, "SELECT count(*) FROM blocks WHERE id LIKE 'new-%'").await;
    let on_b = count(&b2, "SELECT count(*) FROM blocks WHERE id LIKE 'after-backup-%'").await;
    let (da, db) = (engine::digest(&a.pool).await.unwrap(), engine::digest(&b2).await.unwrap());
    eprintln!("new blocks on the computer: {on_a}/3; post-backup blocks back on the phone: {on_b}/5; differing tables: {:?}",
        engine::digest_differences(&da, &db));
    assert_eq!(on_a, 3, "blocks written on the restored phone never reach the computer");
    assert_eq!(on_b, 5, "the computer never sends the restored phone what it had lost");
}

// ---------------------------------------------------------------------------
// 4. A removed device puts itself back
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_removed_device_stays_removed_even_if_its_entry_comes_back() {
    let (a, b, x) = (device().await, device().await, device().await);
    for (d, name, key) in [(&a, "Mac", "aa"), (&b, "Tablet", "bb"), (&x, "Lost phone", "cc")] {
        exec(&d.pool, &format!("INSERT INTO book_devices (id, name, public_key, platform, added_at) VALUES ('{}', '{name}', '{key}', 'x', 'now')", d.id)).await;
    }
    settle(&[&a.pool, &b.pool, &x.pool]).await;

    // The phone is stolen. On the Mac, the author removes it.
    super::service::remove_device(&a.pool, &x.id).await.unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    // The thief renames the phone, and it reaches the tablet before the
    // removal does (the tablet still lists the phone, so it lets it sync).
    exec(&x.pool, &format!("UPDATE book_devices SET name = 'whatever' WHERE id = '{}'", x.id)).await;
    session(&b.pool, &x.pool).await;
    // Mac and tablet sync.
    session(&a.pool, &b.pool).await;
    session(&a.pool, &b.pool).await;

    // The entry may come back through an edit made elsewhere, but the key is
    // on the revocation list, which nothing undoes — on both devices — and
    // the book doesn't count the device any more.
    for d in [&a, &b] {
        assert_eq!(count(&d.pool, "SELECT count(*) FROM book_revocations WHERE public_key = 'cc'").await, 1);
        let listed: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM book_devices WHERE public_key NOT IN (SELECT public_key FROM book_revocations)",
        )
        .fetch_all(&d.pool)
        .await
        .unwrap();
        assert!(!listed.contains(&x.id), "{listed:?}");
    }
}

// ---------------------------------------------------------------------------
// 5. The digest loads every row of a table at once
// ---------------------------------------------------------------------------

fn peak_rss_mb() -> i64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap();
    let line = s.lines().find(|l| l.starts_with("VmHWM:")).unwrap();
    line.split_whitespace().nth(1).unwrap().parse::<i64>().unwrap() / 1024
}

#[tokio::test]
#[ignore = "measures the process's peak memory, so run it on its own: cargo test --lib digest_holds -- --ignored"]
async fn the_digest_holds_a_whole_table_in_memory() {
    let a = device().await;
    // 200 revisions of about 1 MB: a big book's history.
    for i in 0..200u32 {
        let text = format!("{i:03}").repeat(1_000_000 / 3);
        exec(&a.pool, &format!("INSERT INTO revisions (id, block_id, type, position, props, content, created_at) VALUES ('r{i}', 'b', 'paragraph', 'a0', '{{}}', '{text}', 'now')")).await;
    }
    let before = peak_rss_mb();
    engine::digest(&a.pool).await.unwrap();
    let after = peak_rss_mb();
    eprintln!("peak RSS before digest: {before} MB, after: {after} MB");
    assert!(after - before < 50, "digest grew peak memory by {} MB", after - before);
}

// ---------------------------------------------------------------------------
// 6. An UPDATE that changes nothing is a new version, and wins
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_save_that_changes_nothing_on_one_device_cannot_wipe_an_edit_made_on_the_other() {
    let (phone, mac) = (device().await, device().await);
    exec(&mac.pool, &insert_block("b", Some("p"), "draft")).await;
    session(&phone.pool, &mac.pool).await;
    // On the train (no sync): the author rewrites the block on the phone.
    exec(&phone.pool, "UPDATE blocks SET content = 'rewritten' WHERE id = 'b'").await;
    std::thread::sleep(std::time::Duration::from_millis(5));
    // At home, the Mac saves the page again without changing that block.
    exec(&mac.pool, "UPDATE blocks SET content = 'draft', parent_id = 'p' WHERE id = 'b'").await;
    session(&phone.pool, &mac.pool).await;
    let text: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = 'b'").fetch_one(&phone.pool).await.unwrap();
    assert_eq!(text, "rewritten", "the rewrite was overwritten by a save that changed nothing");
}
