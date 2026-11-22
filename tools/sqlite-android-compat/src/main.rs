// Spec: TRG-4
// Applies Commonplace's migrations with SQLite 3.39 (what Android 14 ships) and
// makes the writes the app makes, checking the sync triggers parse and
// record them.
use rusqlite::Connection;
use std::fs;

fn main() {
    let root = std::env::args().nth(1).expect("repo root");
    let conn = Connection::open_in_memory().unwrap();
    println!("sqlite {}", rusqlite::version());
    let lib = fs::read_to_string(format!("{root}/src-tauri/src/lib.rs")).unwrap();
    for line in lib.lines() {
        if let Some(i) = line.find("include_str!(\"../migrations/") {
            let rest = &line[i + "include_str!(\"../migrations/".len()..];
            let file = &rest[..rest.find('"').unwrap()];
            let sql = fs::read_to_string(format!("{root}/src-tauri/migrations/{file}")).unwrap();
            conn.execute_batch(&sql).unwrap_or_else(|e| panic!("{file}: {e}"));
        }
    }
    // The writes the app makes, in shape: settings, a page and its blocks
    // saved with their revisions, a block deleted in the editor, AI usage.
    conn.execute("INSERT INTO settings (key, value) VALUES ('openrouter_api_key', 'k') ON CONFLICT(key) DO UPDATE SET value = excluded.value", []).unwrap();
    conn.execute("INSERT INTO device_settings (key, value) VALUES ('last_page', 'p') ON CONFLICT(key) DO UPDATE SET value = excluded.value", []).unwrap();
    conn.execute("INSERT INTO blocks (id, type, parent_id, position, props, content, created_at, updated_at) VALUES ('p1', 'page', NULL, 'a0', '{\"title\":\"Types\"}', '[]', 'now', 'now')", []).unwrap();
    conn.execute("INSERT INTO blocks (id, type, parent_id, position, props, content, created_at, updated_at) VALUES ('b1', 'paragraph', 'p1', 'a0', '{}', '[]', 'now', 'now')", []).unwrap();
    conn.execute("UPDATE blocks SET content = '[{\"type\":\"text\",\"text\":\"Hi\"}]', updated_at = 'later' WHERE id = 'b1'", []).unwrap();
    conn.execute("INSERT INTO revisions (id, block_id, page_id, type, parent_id, position, props, content, deleted, created_at) VALUES ('r1', 'b1', 'p1', 'paragraph', 'p1', 'a0', '{}', '[]', 0, 'now')", []).unwrap();
    conn.execute("INSERT INTO ai_usage (id, feature, model, prompt_tokens, completion_tokens, cost, created_at) VALUES ('u1', 'assistant', 'm', 1, 1, 0.1, 'now')", []).unwrap();
    conn.execute("UPDATE blocks SET deleted_at = 'later' WHERE id = 'b1'", []).unwrap();
    conn.execute("DELETE FROM revisions WHERE id = 'r1'", []).unwrap();
    // An update that changes nothing records nothing (the WHEN clause).
    let before: i64 = conn.query_row("SELECT seq FROM sync_state", [], |r| r.get(0)).unwrap();
    conn.execute("UPDATE blocks SET deleted_at = 'later' WHERE id = 'b1'", []).unwrap();
    let after: i64 = conn.query_row("SELECT seq FROM sync_state", [], |r| r.get(0)).unwrap();
    assert_eq!(before, after, "a no-op update was recorded");
    // The version-vector entry is the clock of the latest change, as one
    // integer: what's checked is that it's there for every row recorded.
    let mut q = conn.prepare("SELECT tbl, pk, deleted, seq, (SELECT count(*) FROM sync_vv v WHERE v.tbl = r.tbl AND v.pk = r.pk AND v.counter > 1000000) FROM sync_rows r ORDER BY seq").unwrap();
    let rows: Vec<(String, String, i64, i64, i64)> = q
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    for r in &rows {
        println!("{r:?}");
    }
    let expect = [
        ("settings", "openrouter_api_key", 0, 1),
        ("blocks", "p1", 0, 1),
        ("ai_usage", "u1", 0, 1),
        ("blocks", "b1", 0, 1),
        ("revisions", "r1", 1, 1),
    ];
    assert_eq!(rows.len(), expect.len(), "device_settings must not be tracked");
    for ((t, p, d, c), r) in expect.iter().zip(&rows) {
        assert_eq!((*t, *p, *d, *c), (r.0.as_str(), r.1.as_str(), r.2, r.4));
    }
    let seqs: Vec<i64> = rows.iter().map(|r| r.3).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    println!("OK: migrations and the app's writes behave on SQLite {}", rusqlite::version());
}
