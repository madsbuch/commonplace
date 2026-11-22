//! Correctness of the sync engine, on real databases (every app migration
//! applied, triggers and all), several devices in one process.
//!
//! The heart of it is `random_histories_converge`: devices make random edits
//! of the kinds the app makes (pages and blocks added, edited, moved and
//! deleted, each save with its revision; settings; AI usage) and sync in
//! random pairs, with small batches and connections dropped half-way, for
//! many seeds. Afterwards every device must hold exactly the same data and
//! versions, no revision may have been lost (every save is kept), and no chat
//! turn may have been lost unless a deletion had seen it (a chat continued on
//! two devices at once is split, not overwritten).

use super::engine::{self, ApplyStats, Batch, Digest};
use crate::test_db::{migrated_db, Scratch};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub(crate) struct Device {
    pub(crate) pool: SqlitePool,
    pub(crate) id: String,
    pub(crate) _dir: Scratch,
}

pub(crate) async fn device() -> Device {
    let dir = Scratch::new();
    let pool = migrated_db(&dir).await;
    let id = engine::local_state(&pool).await.unwrap().device_id;
    Device { pool, id, _dir: dir }
}

pub(crate) async fn exec(pool: &SqlitePool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// A table of the test's own, put under sync with exactly the triggers the
/// generator (scripts/sync-triggers.ts) writes: the `settings` table's,
/// renamed. Its columns are `key` (the primary key) and `value`, declared as
/// `value_decl` says: a UNIQUE value, or a reference that cascades. The app's
/// own tables have neither, but sync must still handle both.
pub(crate) async fn synced_test_table(pool: &SqlitePool, name: &str, value_decl: &str) {
    exec(pool, &format!("CREATE TABLE `{name}` (`key` text PRIMARY KEY NOT NULL, `value` {value_decl})")).await;
    let triggers: Vec<String> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'settings' ORDER BY name")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(triggers.len(), 3);
    for sql in triggers {
        let sql = sql
            .replace("`sync_settings_", &format!("`sync_{name}_"))
            .replace("ON `settings`", &format!("ON `{name}`"))
            .replace("'settings'", &format!("'{name}'"));
        exec(pool, &sql).await;
    }
}

/// A block as the app writes one: a paragraph holding `content`.
pub(crate) fn insert_block(id: &str, parent: Option<&str>, content: &str) -> String {
    let parent = parent.map_or("NULL".to_string(), |p| format!("'{p}'"));
    format!(
        "INSERT INTO blocks (id, type, parent_id, position, content, created_at, updated_at)
         VALUES ('{id}', 'paragraph', {parent}, 'a0', '{content}', 'now', 'now')"
    )
}

/// The revision the app writes with every save of a block.
fn insert_revision(id: &str, block: &str, content: &str) -> String {
    format!(
        "INSERT INTO revisions (id, block_id, page_id, type, position, props, content, created_at)
         VALUES ('{id}', '{block}', NULL, 'paragraph', 'a0', '{{}}', '{content}', 'now')"
    )
}

async fn sync_pair(a: &Device, b: &Device) -> (ApplyStats, ApplyStats) {
    let x = engine::pull_all(&a.pool, &b.pool, 4, 64 * 1024).await.unwrap();
    let y = engine::pull_all(&b.pool, &a.pool, 4, 64 * 1024).await.unwrap();
    (x, y)
}

/// Pulls at most `batches` batches, as a connection that drops would.
async fn pull_some(into: &Device, from: &Device, batches: usize, rows: i64) {
    for _ in 0..batches {
        let since = engine::pulled_from(&into.pool, &from.id).await.unwrap();
        let batch = engine::export(&from.pool, since, &into.id, rows, 1024).await.unwrap();
        engine::apply(&into.pool, &from.id, &batch).await.unwrap();
        if batch.done {
            break;
        }
    }
}

/// Every synced table's rows, with their versions, as comparable text.
pub(crate) async fn dump(pool: &SqlitePool) -> BTreeMap<String, Vec<String>> {
    let mut conn = pool.acquire().await.unwrap();
    let tables = engine::synced_tables(&mut conn).await.unwrap();
    let mut out = BTreeMap::new();
    for t in tables.values() {
        let rows = sqlx::query(&format!("SELECT * FROM \"{}\" ORDER BY \"{}\"", t.name, t.pk))
            .fetch_all(&mut *conn)
            .await
            .unwrap();
        let mut lines: Vec<String> = Vec::new();
        for r in &rows {
            use sqlx::{Column, Row, ValueRef};
            let mut cells = Vec::new();
            for (i, c) in r.columns().iter().enumerate() {
                let raw = r.try_get_raw(i).unwrap();
                let v = if raw.is_null() {
                    "NULL".to_string()
                } else {
                    match r.try_get_unchecked::<String, _>(i) {
                        Ok(s) => s,
                        Err(_) => format!("{:?}", r.try_get_unchecked::<Vec<u8>, _>(i).unwrap()),
                    }
                };
                cells.push(format!("{}={}", c.name(), v));
            }
            lines.push(cells.join("|"));
        }
        out.insert(t.name.clone(), lines);
    }
    let versions: Vec<(String, String, String, String, i64)> =
        sqlx::query_as("SELECT tbl, pk, hlc, origin, deleted FROM sync_rows ORDER BY tbl, pk")
            .fetch_all(&mut *conn)
            .await
            .unwrap();
    out.insert("~versions".into(), versions.iter().map(|v| format!("{v:?}")).collect());
    let vv: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT tbl, pk, device, counter FROM sync_vv ORDER BY tbl, pk, device")
            .fetch_all(&mut *conn)
            .await
            .unwrap();
    out.insert("~vv".into(), vv.iter().map(|v| format!("{v:?}")).collect());
    out
}

fn uuid(rng: &mut StdRng) -> String {
    let b: [u8; 16] = rng.gen();
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

async fn ids(pool: &SqlitePool, sql: &str) -> Vec<String> {
    sqlx::query_scalar(sql).fetch_all(pool).await.unwrap()
}

fn pick<'a>(rng: &mut StdRng, v: &'a [String]) -> Option<&'a String> {
    if v.is_empty() {
        None
    } else {
        Some(&v[rng.gen_range(0..v.len())])
    }
}

/// What the chats check watches: every turn ever written, and the turns a
/// deletion had seen when it removed them.
#[derive(Default)]
struct Turns {
    written: BTreeSet<String>,
    deleted_knowingly: HashSet<String>,
}

fn turns_of(messages: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(messages).unwrap();
    v.as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect()
}

async fn chat_turns(pool: &SqlitePool) -> BTreeSet<String> {
    let all: Vec<String> = sqlx::query_scalar("SELECT messages FROM chats").fetch_all(pool).await.unwrap();
    all.iter().flat_map(|m| turns_of(m)).collect()
}

/// Saves a block as the app does: the block's row, and a revision of it.
async fn save(rng: &mut StdRng, p: &SqlitePool, block: &str, set: &str, saved: &mut BTreeSet<String>) {
    exec(p, &format!("UPDATE blocks SET {set} WHERE id = '{block}'")).await;
    let rev = uuid(rng);
    exec(p, &insert_revision(&rev, block, "saved")).await;
    saved.insert(rev);
}

/// One random edit of the kind the app makes. `saved` collects the id of
/// every revision written, which must all survive; `turns` every chat turn.
async fn random_edit(rng: &mut StdRng, d: &Device, saved: &mut BTreeSet<String>, turns: &mut Turns, n: usize) {
    let p = &d.pool;
    match rng.gen_range(0..16) {
        0 => {
            // A new top-level page.
            let id = uuid(rng);
            exec(
                p,
                &format!(
                    "INSERT INTO blocks (id, type, parent_id, position, props, created_at, updated_at)
                     VALUES ('{id}', 'page', NULL, 'a{n}', '{{\"title\":\"page {n}\"}}', 'now', 'now')"
                ),
            )
            .await;
            let rev = uuid(rng);
            exec(p, &insert_revision(&rev, &id, "page")).await;
            saved.insert(rev);
        }
        1 | 2 => {
            // A block typed into a page (maybe one deleted elsewhere meanwhile).
            let parent = pick(rng, &ids(p, "SELECT id FROM blocks WHERE type = 'page'").await).cloned();
            let id = uuid(rng);
            exec(p, &insert_block(&id, parent.as_deref(), &format!("block {n}"))).await;
            let rev = uuid(rng);
            exec(p, &insert_revision(&rev, &id, "typed")).await;
            saved.insert(rev);
        }
        3..=5 => {
            // Text edited: the same blocks edited on several devices conflict.
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM blocks WHERE type <> 'page'").await) {
                save(rng, p, id, &format!("content = 'edited {n} on {}', updated_at = 'now'", &d.id[..4]), saved).await;
            }
        }
        6 => {
            // Moved to another page, or elsewhere among its siblings.
            let blocks = ids(p, "SELECT id FROM blocks WHERE type <> 'page'").await;
            let pages = ids(p, "SELECT id FROM blocks WHERE type = 'page'").await;
            if let (Some(id), Some(page)) = (pick(rng, &blocks), pick(rng, &pages)) {
                save(rng, p, id, &format!("parent_id = '{page}', position = 'a{n}'"), saved).await;
            }
        }
        7 => {
            // Deleted in the editor: the row stays, marked.
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM blocks WHERE deleted_at IS NULL").await) {
                save(rng, p, id, "deleted_at = 'now'", saved).await;
            }
        }
        8 => {
            // A row really deleted.
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM blocks").await) {
                exec(p, &format!("DELETE FROM blocks WHERE id = '{id}'")).await;
            }
        }
        9 => {
            let key = ["assistant_model", "openrouter_api_key", "theme"][rng.gen_range(0..3)];
            sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(key)
                .bind(format!("v{n}"))
                .execute(p)
                .await
                .unwrap();
        }
        10 => {
            let id = uuid(rng);
            exec(
                p,
                &format!(
                    "INSERT INTO ai_usage (id, feature, model, prompt_tokens, completion_tokens, cost, created_at)
                     VALUES ('{id}', 'assistant', 'm', 10, 20, 0.001, 'now')"
                ),
            )
            .await;
        }
        12 => {
            // A new chat.
            let id = uuid(rng);
            let turn = format!("{}:{n}:first", d.id);
            turns.written.insert(turn.clone());
            exec(p, &format!("INSERT INTO chats (id, title, messages, created_at, updated_at) VALUES ('{id}', 'chat {n}', '[\"{turn}\"]', 'now', 'now')")).await;
        }
        13 | 14 => {
            // A chat continued: the same chat on several devices conflicts.
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM chats").await) {
                let messages: String = sqlx::query_scalar("SELECT messages FROM chats WHERE id = ?").bind(id).fetch_one(p).await.unwrap();
                let mut t = turns_of(&messages);
                let turn = format!("{}:{n}:turn", d.id);
                turns.written.insert(turn.clone());
                t.push(turn);
                let json = serde_json::to_string(&t).unwrap();
                sqlx::query("UPDATE chats SET messages = ?, updated_at = 'now' WHERE id = ?").bind(json).bind(id).execute(p).await.unwrap();
            }
        }
        15 => {
            // A chat deleted: the turns it held go knowingly.
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM chats").await) {
                let messages: String = sqlx::query_scalar("SELECT messages FROM chats WHERE id = ?").bind(id).fetch_one(p).await.unwrap();
                turns.deleted_knowingly.extend(turns_of(&messages));
                exec(p, &format!("DELETE FROM chats WHERE id = '{id}'")).await;
            }
        }
        _ => {
            // A long block: big rows still go, one per batch if need be.
            if let Some(id) = pick(rng, &ids(p, "SELECT id FROM blocks WHERE type <> 'page'").await) {
                let long = "x".repeat(rng.gen_range(2_000..40_000));
                save(rng, p, id, &format!("content = '{long}'"), saved).await;
            }
        }
    }
}

/// Syncs every pair until a whole round changes nothing anywhere, cleaning up
/// orphans as the app does after a sync. Panics if it doesn't settle.
async fn settle(devices: &[Device]) {
    for round in 0..12 {
        let mut changed = 0;
        for i in 0..devices.len() {
            for j in 0..devices.len() {
                if i != j {
                    let s = engine::pull_all(&devices[i].pool, &devices[j].pool, 7, 16 * 1024).await.unwrap();
                    changed += s.applied + s.conflicts + s.forks + s.unique_merges;
                }
            }
        }
        for d in devices {
            changed += engine::remove_orphans(&d.pool).await.unwrap() as usize;
        }
        if changed == 0 {
            return;
        }
        assert!(round < 11, "sync didn't settle");
    }
}

async fn assert_identical(devices: &[Device]) {
    let first = dump(&devices[0].pool).await;
    let first_digest = engine::digest(&devices[0].pool).await.unwrap();
    for d in &devices[1..] {
        let other = dump(&d.pool).await;
        for (table, rows) in &first {
            assert_eq!(rows, &other[table], "{table} differs between devices");
        }
        let digest = engine::digest(&d.pool).await.unwrap();
        assert_eq!(engine::digest_differences(&first_digest, &digest), Vec::<String>::new());
    }
    for d in devices {
        let fk: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check").fetch_all(&d.pool).await.unwrap();
        assert!(fk.is_empty(), "dangling references: {fk:?}");
        let applying: i64 = sqlx::query_scalar("SELECT applying FROM sync_state").fetch_one(&d.pool).await.unwrap();
        assert_eq!(applying, 0);
    }
}

async fn run_history(seed: u64, devices_n: usize, steps: usize) {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut devices = Vec::new();
    for _ in 0..devices_n {
        devices.push(device().await);
    }
    let mut saved = BTreeSet::new();
    let mut turns = Turns::default();
    for n in 0..steps {
        let d = rng.gen_range(0..devices_n);
        random_edit(&mut rng, &devices[d], &mut saved, &mut turns, n).await;
        if rng.gen_bool(0.25) {
            let a = rng.gen_range(0..devices_n);
            let b = (a + rng.gen_range(1..devices_n)) % devices_n;
            if rng.gen_bool(0.3) {
                // A connection that drops part-way.
                let k = rng.gen_range(0..3);
                let rows = rng.gen_range(1..4);
                pull_some(&devices[a], &devices[b], k, rows).await;
            } else {
                sync_pair(&devices[a], &devices[b]).await;
            }
        }
    }
    settle(&devices).await;
    assert_identical(&devices).await;

    // Spec: SYN-14
    // No save lost: every revision ever written is on every device.
    let kept: BTreeSet<String> = ids(&devices[0].pool, "SELECT id FROM revisions").await.into_iter().collect();
    for r in &saved {
        assert!(kept.contains(r), "seed {seed}: revision {r} was lost");
    }

    // Spec: SYN-20
    // No chat turn lost, unless a deletion had seen it.
    let kept_turns = chat_turns(&devices[0].pool).await;
    for t in &turns.written {
        assert!(kept_turns.contains(t) || turns.deleted_knowingly.contains(t), "seed {seed}: turn {t} was lost");
    }

    // Quiet once settled: nothing more moves, in either direction.
    for i in 0..devices_n {
        for j in 0..devices_n {
            if i != j {
                let s = engine::pull_all(&devices[i].pool, &devices[j].pool, 50, 1 << 20).await.unwrap();
                assert_eq!(s.applied + s.conflicts + s.forks, 0, "seed {seed}: still moving after settling");
            }
        }
    }
}

// Spec: SYN-11, SYN-12, SYN-20
#[tokio::test(flavor = "multi_thread")]
async fn random_histories_converge_between_two_devices() {
    for seed in 0..25 {
        run_history(seed, 2, 120).await;
    }
}

// Spec: SYN-12
#[tokio::test(flavor = "multi_thread")]
async fn random_histories_converge_between_three_devices() {
    for seed in 100..115 {
        run_history(seed, 3, 160).await;
    }
}

// ---------------------------------------------------------------------------
// Specific cases, spelled out
// ---------------------------------------------------------------------------

async fn content(pool: &SqlitePool, id: &str) -> String {
    sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?").bind(id).fetch_one(pool).await.unwrap()
}

async fn chat_rows(pool: &SqlitePool) -> Vec<(String, String, String)> {
    sqlx::query_as("SELECT id, title, messages FROM chats ORDER BY title").fetch_all(pool).await.unwrap()
}

const INSERT_PLAN: &str = "INSERT INTO chats (id, title, messages, created_at, updated_at) VALUES ('c', 'Plan', '[\"q1\"]', 'now', 'now')";

// Spec: SYN-20
#[tokio::test]
async fn a_chat_continued_on_both_devices_is_split_in_two() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, INSERT_PLAN).await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"phone q\"]' WHERE id = 'c'").await;
    exec(&b.pool, "UPDATE chats SET messages = '[\"q1\",\"mac q\"]' WHERE id = 'c'").await;
    let (x, y) = sync_pair(&a, &b).await;
    assert_eq!(x.forks + y.forks, 1);
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let kept = chat_turns(&devices[0].pool).await;
    assert!(kept.contains("phone q") && kept.contains("mac q"), "{kept:?}");
}

// Spec: SYN-20
#[tokio::test]
async fn a_split_chat_comes_out_the_same_on_both_devices() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, INSERT_PLAN).await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"phone\"]' WHERE id = 'c'").await;
    std::thread::sleep(std::time::Duration::from_millis(5));
    exec(&b.pool, "UPDATE chats SET messages = '[\"q1\",\"mac\"]' WHERE id = 'c'").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let chats = chat_rows(&devices[0].pool).await;
    assert_eq!(chats.len(), 2, "{chats:?}");
    // The later edit (the Mac's) keeps the chat; the phone's becomes its own.
    assert_eq!(chats[0], ("c".into(), "Plan".into(), "[\"q1\",\"mac\"]".into()));
    assert_eq!(chats[1].1, "Plan (continued in parallel)");
    // A chat id like any other: `chat_` and 26 digits of TypeID base32.
    let (prefix, suffix) = chats[1].0.split_once('_').unwrap();
    assert_eq!(prefix, "chat", "{}", chats[1].0);
    assert!(suffix.len() == 26 && suffix.bytes().all(|c| b"0123456789abcdefghjkmnpqrstvwxyz".contains(&c)), "{}", chats[1].0);
    assert_eq!(chats[1].2, "[\"q1\",\"phone\"]");
}

// Spec: SYN-20
#[tokio::test]
async fn a_chat_continued_on_one_device_just_moves_along() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, INSERT_PLAN).await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"a1\"]' WHERE id = 'c'").await;
    exec(&a.pool, "UPDATE chats SET messages = '[\"q1\",\"a1\",\"q2\"]' WHERE id = 'c'").await;
    let (_, y) = sync_pair(&a, &b).await;
    assert_eq!((y.forks, y.conflicts), (0, 0));
    assert_eq!(chat_rows(&b.pool).await, vec![("c".into(), "Plan".into(), "[\"q1\",\"a1\",\"q2\"]".into())]);
}

// Spec: SYN-20
#[tokio::test]
async fn a_chat_deleted_on_one_device_and_continued_on_the_other_is_kept() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, INSERT_PLAN).await;
    sync_pair(&a, &b).await;
    exec(&b.pool, "UPDATE chats SET messages = '[\"q1\",\"mac\"]' WHERE id = 'c'").await;
    exec(&a.pool, "DELETE FROM chats WHERE id = 'c'").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let kept = chat_turns(&devices[0].pool).await;
    assert!(kept.contains("mac"), "{kept:?}");
}

// Spec: SYN-14
#[tokio::test]
async fn a_block_edited_on_both_devices_keeps_both_edits_as_revisions() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, &insert_block("blk", None, "draft")).await;
    exec(&a.pool, &insert_revision("r0", "blk", "draft")).await;
    sync_pair(&a, &b).await;
    // Edited on both before they sync, each save with its revision.
    exec(&a.pool, "UPDATE blocks SET content = 'from the phone' WHERE id = 'blk'").await;
    exec(&a.pool, &insert_revision("r-phone", "blk", "from the phone")).await;
    std::thread::sleep(std::time::Duration::from_millis(5));
    exec(&b.pool, "UPDATE blocks SET content = 'from the mac' WHERE id = 'blk'").await;
    exec(&b.pool, &insert_revision("r-mac", "blk", "from the mac")).await;

    let (x, y) = sync_pair(&a, &b).await;
    assert_eq!(x.conflicts + y.conflicts, 1);
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    // The later edit is the block's text; both are kept as revisions.
    assert_eq!(content(&devices[0].pool, "blk").await, "from the mac");
    let revs = ids(&devices[0].pool, "SELECT content FROM revisions WHERE block_id = 'blk' ORDER BY content").await;
    assert_eq!(revs, vec!["draft", "from the mac", "from the phone"]);
}

#[tokio::test]
async fn edits_to_different_blocks_of_a_page_never_conflict() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, &insert_block("one", Some("page"), "first")).await;
    exec(&a.pool, &insert_block("two", Some("page"), "second")).await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE blocks SET content = 'first, revised' WHERE id = 'one'").await;
    exec(&b.pool, "UPDATE blocks SET content = 'second, revised' WHERE id = 'two'").await;
    let (x, y) = sync_pair(&a, &b).await;
    assert_eq!(x.conflicts + y.conflicts, 0);
    assert_eq!(content(&a.pool, "two").await, "second, revised");
    assert_eq!(content(&b.pool, "one").await, "first, revised");
}

#[tokio::test]
async fn a_block_moved_on_one_device_and_edited_on_the_other_settles_the_same_everywhere() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, &insert_block("blk", Some("p1"), "text")).await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE blocks SET parent_id = 'p2', position = 'b0' WHERE id = 'blk'").await;
    exec(&b.pool, "UPDATE blocks SET content = 'text, edited' WHERE id = 'blk'").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
}

#[tokio::test]
async fn deletes_reach_the_other_device_and_stay_deleted() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, &insert_block("m", None, "text")).await;
    sync_pair(&a, &b).await;
    exec(&b.pool, "DELETE FROM blocks WHERE id = 'm'").await;
    sync_pair(&a, &b).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks").fetch_one(&a.pool).await.unwrap();
    assert_eq!(n, 0);
    // A stale copy of the old version arriving later can't bring it back.
    let c = device().await;
    let devices = [a, b, c];
    settle(&devices).await;
    assert_identical(&devices).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks").fetch_one(&devices[2].pool).await.unwrap();
    assert_eq!(n, 0);
}

// Spec: SYN-11
#[tokio::test]
async fn concurrent_edits_to_a_row_settle_on_the_later_one_everywhere() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, &insert_block("m", None, "text")).await;
    sync_pair(&a, &b).await;
    exec(&a.pool, "UPDATE blocks SET content = 'first' WHERE id = 'm'").await;
    std::thread::sleep(std::time::Duration::from_millis(5));
    exec(&b.pool, "UPDATE blocks SET content = 'second' WHERE id = 'm'").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    assert_eq!(content(&devices[0].pool, "m").await, "second");
}

// Spec: SYN-13
#[tokio::test]
async fn two_rows_that_collide_on_a_unique_column_end_up_as_the_lower_id() {
    let (a, b) = (device().await, device().await);
    for d in [&a, &b] {
        synced_test_table(&d.pool, "tags", "text NOT NULL UNIQUE").await;
    }
    exec(&a.pool, "INSERT INTO tags (key, value) VALUES ('b-id', 'Type theory')").await;
    exec(&b.pool, "INSERT INTO tags (key, value) VALUES ('a-id', 'Type theory')").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let keys = ids(&devices[0].pool, "SELECT key FROM tags WHERE value = 'Type theory'").await;
    assert_eq!(keys, vec!["a-id".to_string()]);
}

#[tokio::test]
async fn big_rows_arrive_intact() {
    let (a, b) = (device().await, device().await);
    let long = "λ".repeat(300_000);
    exec(&a.pool, &insert_block("big", None, &long)).await;
    exec(&a.pool, &insert_block("small", None, "short")).await;
    // Small batches: the big row still goes, one per batch.
    engine::pull_all(&b.pool, &a.pool, 50, 1024).await.unwrap();
    assert_eq!(content(&b.pool, "big").await, long);
    assert_eq!(content(&b.pool, "small").await, "short");
}

#[tokio::test]
async fn an_interrupted_pull_resumes_where_it_stopped() {
    let (a, b) = (device().await, device().await);
    for i in 0..40 {
        exec(&a.pool, &format!("INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m{i:02}', 'paragraph', 'a0', 'text', 'now', 'now')")).await;
    }
    pull_some(&b, &a, 2, 5).await;
    let half: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks").fetch_one(&b.pool).await.unwrap();
    assert!(half > 0 && half < 40);
    let s = engine::pull_all(&b.pool, &a.pool, 5, 1 << 20).await.unwrap();
    // Exactly the rest: nothing pulled before the drop came again.
    assert_eq!(s.applied as i64, 40 - half);
    let all: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks").fetch_one(&b.pool).await.unwrap();
    assert_eq!(all, 40);
}

#[tokio::test]
async fn applying_the_same_batch_twice_changes_nothing() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    let batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    let before = dump(&b.pool).await;
    let again = engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    assert_eq!(again.applied, 0);
    let after = dump(&b.pool).await;
    assert_eq!(before.get("blocks"), after.get("blocks"));
}

#[tokio::test]
async fn a_bad_batch_changes_nothing_at_all() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    let before = dump(&b.pool).await;
    // A change for a table that isn't synced, at the end of an otherwise good batch.
    let mut evil = batch.changes[0].clone();
    evil.tbl = "sync_state".into();
    batch.changes.push(evil);
    assert!(engine::apply(&b.pool, &a.id, &batch).await.is_err());
    assert_eq!(dump(&b.pool).await, before);
    assert_eq!(engine::pulled_from(&b.pool, &a.id).await.unwrap(), 0);
    let applying: i64 = sqlx::query_scalar("SELECT applying FROM sync_state").fetch_one(&b.pool).await.unwrap();
    assert_eq!(applying, 0);
}

#[tokio::test]
async fn a_change_with_unknown_columns_is_refused() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    let mut batch: Batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    let c = batch.changes.iter_mut().find(|c| c.tbl == "blocks").unwrap();
    c.data.as_mut().unwrap().push(("evil".into(), engine::Value::Text("x".into())));
    assert!(engine::apply(&b.pool, &a.id, &batch).await.is_err());
}

#[tokio::test]
async fn local_writes_made_during_a_sync_are_still_recorded() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    sync_pair(&a, &b).await;
    exec(&b.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('n', 'paragraph', 'a0', 'Second', 'now', 'now')").await;
    let devices = [a, b];
    settle(&devices).await;
    assert_identical(&devices).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks").fetch_one(&devices[0].pool).await.unwrap();
    assert_eq!(n, 2);
}

#[tokio::test]
async fn joining_needs_an_empty_device_and_then_receives_everything() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "UPDATE sync_state SET book_id = 'v'").await;
    for i in 0..30 {
        exec(&a.pool, &format!("INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m{i}', 'paragraph', 'a0', 'text', 'now', 'now')")).await;
    }
    exec(&a.pool, "INSERT INTO revisions (id, block_id, type, position, props, content, created_at) VALUES ('r', 'm0', 'paragraph', 'a0', '{}', 'text', 'now')").await;
    exec(&a.pool, "INSERT INTO settings (key, value) VALUES ('openrouter_api_key', 'sk-123')").await;

    // A device with data of its own is refused, and keeps it.
    exec(&b.pool, "INSERT INTO revisions (id, block_id, type, position, props, content, created_at) VALUES ('f', 'b', 'paragraph', 'a0', '{}', 'x', 'now')").await;
    assert!(engine::reset_for_join(&b.pool, "v", "new-b", None, false).await.is_err());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM revisions").fetch_one(&b.pool).await.unwrap();
    assert_eq!(n, 1);

    // An empty one (settings don't count) joins.
    let c = device().await;
    exec(&c.pool, "INSERT INTO settings (key, value) VALUES ('assistant_model', 'some/model')").await;
    let old_id = c.id.clone();
    let new_id = crate::sync::new_uuid();
    engine::reset_for_join(&c.pool, "v", &new_id, None, false).await.unwrap();
    assert_ne!(new_id, old_id);
    let c = Device { id: new_id, ..c };
    engine::pull_all(&c.pool, &a.pool, 10, 1 << 20).await.unwrap();
    let devices = [a, c];
    settle(&devices).await;
    assert_identical(&devices).await;
    let key: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'openrouter_api_key'").fetch_one(&devices[1].pool).await.unwrap();
    assert_eq!(key, "sk-123");
}

#[tokio::test]
async fn the_digest_notices_any_difference() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    sync_pair(&a, &b).await;
    let same: Digest = engine::digest(&a.pool).await.unwrap();
    assert!(engine::digest_differences(&same, &engine::digest(&b.pool).await.unwrap()).is_empty());
    // Changed behind sync's back (no trigger): the digest still sees it.
    exec(&b.pool, "UPDATE sync_state SET applying = 1").await;
    exec(&b.pool, "UPDATE blocks SET content = 'Second'").await;
    exec(&b.pool, "UPDATE sync_state SET applying = 0").await;
    let diff = engine::digest_differences(&same, &engine::digest(&b.pool).await.unwrap());
    assert_eq!(diff, vec!["blocks".to_string()]);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_peer_with_a_clock_years_ahead_cannot_drag_ours_along() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    for c in &mut batch.changes {
        c.hlc = "9999999999999.000000".into();
    }
    engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    let ms: i64 = sqlx::query_scalar("SELECT hlc_ms FROM sync_state").fetch_one(&b.pool).await.unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    assert!(ms <= now + 24 * 3600 * 1000 + 1000, "clock dragged to {ms}");
}

#[tokio::test]
async fn the_clock_rolls_into_the_next_millisecond_rather_than_overflow() {
    let a = device().await;
    let ahead = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 3_600_000;
    exec(&a.pool, &format!("UPDATE sync_state SET hlc_ms = {ahead}, hlc_counter = 999999")).await;
    exec(&a.pool, "INSERT INTO revisions (id, block_id, type, position, props, content, created_at) VALUES ('f', 'b', 'paragraph', 'a0', '{}', 'x', 'now')").await;
    let hlc: String = sqlx::query_scalar("SELECT hlc FROM sync_rows WHERE pk = 'f'").fetch_one(&a.pool).await.unwrap();
    assert_eq!(hlc, format!("{:013}.000000", ahead + 1));
}

#[tokio::test]
async fn malformed_clock_values_are_refused() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    for bad in ["1.2", "99999999999999.000000", "0000000000001.0000001", "000000000000a.000000"] {
        let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
        batch.changes[0].hlc = bad.into();
        assert!(engine::apply(&b.pool, &a.id, &batch).await.is_err(), "{bad} accepted");
    }
}

#[tokio::test]
async fn an_update_that_changes_nothing_is_not_a_new_version() {
    let a = device().await;
    exec(&a.pool, "INSERT INTO blocks (id, type, position, content, created_at, updated_at) VALUES ('m', 'paragraph', 'a0', 'Draft', 'now', 'now')").await;
    let before: (String, i64) = sqlx::query_as("SELECT hlc, seq FROM sync_rows WHERE pk = 'm'").fetch_one(&a.pool).await.unwrap();
    exec(&a.pool, "UPDATE blocks SET content = 'Draft', props = '{}' WHERE id = 'm'").await;
    let after: (String, i64) = sqlx::query_as("SELECT hlc, seq FROM sync_rows WHERE pk = 'm'").fetch_one(&a.pool).await.unwrap();
    assert_eq!(before, after);
    exec(&a.pool, "UPDATE blocks SET content = 'Rewritten' WHERE id = 'm'").await;
    let changed: (String, i64) = sqlx::query_as("SELECT hlc, seq FROM sync_rows WHERE pk = 'm'").fetch_one(&a.pool).await.unwrap();
    assert!(changed.1 > before.1);
}

#[tokio::test]
async fn a_revocation_cannot_be_deleted_by_a_peer() {
    let (a, b) = (device().await, device().await);
    exec(&a.pool, "INSERT INTO book_revocations (public_key, device_id, revoked_at) VALUES ('cc', 'lost', 'now')").await;
    sync_pair(&a, &b).await;
    // A modified client claims a newer deletion of it.
    let mut batch = engine::export(&a.pool, 0, &b.id, 100, 1 << 20).await.unwrap();
    let c = batch.changes.iter_mut().find(|c| c.tbl == "book_revocations").unwrap();
    c.deleted = true;
    c.data = None;
    c.hlc = "9999999999999.000000".into();
    for v in c.vv.values_mut() {
        *v += 1_000_000_000_000_000;
    }
    engine::apply(&b.pool, &a.id, &batch).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM book_revocations").fetch_one(&b.pool).await.unwrap();
    assert_eq!(n, 1);
}
