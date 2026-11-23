// Change tracking (the sync migration, 0001_sync.sql): every write to a
// synced table, whichever code path makes it, leaves a version in sync_rows
// and an entry in sync_vv. Run on the app's real migrations, in bun:sqlite.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { LOCAL_TABLES } from "../scripts/sync-triggers";

const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const files = [...rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map((m) => m[1] ?? "");
const read = (f: string) => readFileSync(new URL(`../src-tauri/migrations/${f}`, import.meta.url), "utf8");
const SYNC_MIGRATION = "0001_sync.sql";

function migrated(): Database {
  const db = new Database(":memory:");
  for (const f of files) db.exec(read(f));
  return db;
}

function one<T>(schema: z.ZodType<T>, raw: unknown): T {
  return schema.parse(raw);
}

// Version-vector entries are clock values as 64-bit integers (~1.8e18):
// beyond what a JS number holds exactly, so they're read as text and
// compared as BigInt.
const VersionRow = z.object({ hlc: z.string(), origin: z.string(), deleted: z.number(), seq: z.number(), vv: z.string() });
const NameRow = z.object({ name: z.string() });
const DeviceRow = z.object({ device_id: z.string() });

function versionOf(db: Database, tbl: string, pk: string) {
  const r = VersionRow.nullable().parse(
    db
      .query(
        `SELECT hlc, origin, deleted, seq,
           (SELECT CAST(coalesce(sum(counter), 0) AS TEXT) FROM sync_vv v WHERE v.tbl = r.tbl AND v.pk = r.pk) AS vv
         FROM sync_rows r WHERE tbl = ? AND pk = ?`,
      )
      .get(tbl, pk),
  );
  return r ? { ...r, vv: BigInt(r.vv) } : null;
}

function must<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw new Error(`expected ${what}`);
  return v;
}

const insertBlock = (id: string, content: string) =>
  `INSERT INTO blocks (id, type, parent_id, position, props, content, created_at, updated_at)
   VALUES ('${id}', 'paragraph', NULL, 'a0', '{}', '${content}', 'now', 'now')`;

describe("sync tracking", () => {
  const db = migrated();

  // Spec: tandem.TRG-1, tandem.SYN-10
  test("every table is either tracked by all three triggers or declared local", () => {
    const tables = z.array(NameRow).parse(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((t) => t.name);
    const triggers = new Set(z.array(NameRow).parse(db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).map((t) => t.name));
    const untracked: string[] = [];
    for (const t of tables) {
      const has = ["ai", "au", "ad"].map((k) => triggers.has(`sync_${t}_${k}`));
      if (LOCAL_TABLES.includes(t)) {
        expect(has).toEqual([false, false, false]);
      } else if (!has.every(Boolean)) {
        untracked.push(t);
      }
    }
    // A table here was added (or rebuilt, which drops triggers) without its
    // sync triggers: generate them with `bun scripts/sync-triggers.ts <table>`.
    expect(untracked).toEqual([]);
    expect(tables).toContain("blocks");
    expect(tables).toContain("revisions");
  });

  // Spec: tandem.TRG-2, tandem.TRG-3, tandem.TRG-5
  test("every update trigger watches every column of its table", () => {
    // A column added later (ALTER TABLE … ADD) must be added to the trigger's
    // list too (`bun scripts/sync-triggers.ts --retrigger <table>`), or
    // changes to it alone would never sync.
    const triggers = z
      .array(z.object({ tbl_name: z.string(), sql: z.string() }))
      .parse(db.query("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%\\_au' ESCAPE '\\'").all());
    expect(triggers.length).toBeGreaterThan(4);
    for (const t of triggers) {
      const watched = [...t.sql.matchAll(/OLD\.`([^`]+)` IS NOT NEW\./g)].map((m) => m[1] ?? "").sort();
      const columns = z.array(NameRow).parse(db.query(`PRAGMA table_info("${t.tbl_name}")`).all()).map((c) => c.name).sort();
      expect({ table: t.tbl_name, watched }).toEqual({ table: t.tbl_name, watched: columns });
    }
  });

  test("inserts, updates and deletes are recorded", () => {
    db.exec(insertBlock("blk_one", "draft"));
    const v1 = must(versionOf(db, "blocks", "blk_one"), "a sync version");
    expect(v1.deleted).toBe(0);
    expect(v1.vv > 0n).toBe(true);
    const device = one(DeviceRow, db.query("SELECT device_id FROM sync_state").get()).device_id;
    expect(v1.origin).toBe(device);

    db.exec("UPDATE blocks SET content = 'revised' WHERE id = 'blk_one'");
    const v2 = must(versionOf(db, "blocks", "blk_one"), "a sync version");
    expect(v2.vv > v1.vv).toBe(true);
    expect(v2.seq).toBeGreaterThan(v1.seq);
    expect(v2.hlc > v1.hlc).toBe(true);

    db.exec("DELETE FROM blocks WHERE id = 'blk_one'");
    const v3 = must(versionOf(db, "blocks", "blk_one"), "a sync version");
    expect(v3.deleted).toBe(1);
    expect(v3.vv > v2.vv).toBe(true);
    expect(v3.hlc > v2.hlc).toBe(true);
  });

  test("an update that changes nothing is not a new version", () => {
    db.exec(insertBlock("blk_same", "text"));
    const before = must(versionOf(db, "blocks", "blk_same"), "a sync version");
    db.exec("UPDATE blocks SET content = 'text' WHERE id = 'blk_same'");
    expect(must(versionOf(db, "blocks", "blk_same"), "a sync version").seq).toBe(before.seq);
  });

  // Spec: tandem.SYN-15
  test("upserts are recorded; device-local settings are not", () => {
    const upsert = (table: string, key: string, value: string) =>
      db.query(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
    upsert("settings", "assistant_model", "a/b");
    const first = must(versionOf(db, "settings", "assistant_model"), "a sync version");
    upsert("settings", "assistant_model", "c/d");
    const second = must(versionOf(db, "settings", "assistant_model"), "a sync version");
    expect(second.deleted).toBe(0);
    expect(second.seq).toBeGreaterThan(first.seq);
    upsert("device_settings", "models_cache", "[]");
    expect(versionOf(db, "device_settings", "models_cache")).toBeNull();
  });

  test("writes made while the sync engine applies are left to it", () => {
    db.exec("UPDATE sync_state SET applying = 1");
    try {
      db.exec(insertBlock("blk_applied", "from a peer"));
    } finally {
      db.exec("UPDATE sync_state SET applying = 0");
    }
    expect(versionOf(db, "blocks", "blk_applied")).toBeNull();
  });

  test("the clock never goes backwards, even within one millisecond", () => {
    const before = one(z.object({ h: z.string() }), db.query("SELECT max(hlc) AS h FROM sync_rows").get()).h;
    for (let i = 0; i < 50; i++) {
      db.query(
        "INSERT INTO revisions (id, block_id, type, position, props, content, created_at) VALUES (?, 'b', 'paragraph', 'a0', '{}', 'x', 'now')",
      ).run(`rev_${i}`);
    }
    const hlcs = z
      .array(z.object({ hlc: z.string() }))
      .parse(db.query("SELECT hlc FROM sync_rows WHERE tbl = 'revisions' ORDER BY seq").all())
      .map((r) => r.hlc);
    expect(hlcs).toHaveLength(50);
    for (let i = 1; i < hlcs.length; i++) expect((hlcs[i] ?? "") > (hlcs[i - 1] ?? "")).toBe(true);
    expect((hlcs[0] ?? "") > before).toBe(true);
  });
});

describe("the sync migration on an existing database", () => {
  test("records every row already there, once, in order", () => {
    const db = new Database(":memory:");
    for (const f of files) {
      if (f === SYNC_MIGRATION) break;
      db.exec(read(f));
    }
    db.exec(`${insertBlock("blk_page", "a page")};
      INSERT INTO revisions (id, block_id, type, position, props, content, created_at) VALUES ('rev_1', 'blk_page', 'page', 'a0', '{}', '', 'x');
      INSERT INTO settings (key, value) VALUES ('assistant_model', 'a/b');
      INSERT INTO device_settings (key, value) VALUES ('last_page', 'x');`);
    db.exec("BEGIN");
    db.exec(read(SYNC_MIGRATION));
    db.exec("COMMIT");

    const rows = z.array(z.object({ tbl: z.string(), pk: z.string(), seq: z.number() })).parse(db.query("SELECT tbl, pk, seq FROM sync_rows ORDER BY seq").all());
    expect(rows.map((r) => `${r.tbl}/${r.pk}`)).toEqual(["settings/assistant_model", "blocks/blk_page", "revisions/rev_1"]);
    // Seqs are unique, start at 1 and leave no gaps; the counter carries on from there.
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    const state = one(z.object({ seq: z.number(), device_id: z.string() }), db.query("SELECT seq, device_id FROM sync_state").get());
    expect(state.seq).toBe(rows.length);
    expect(state.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(db.query("SELECT count(*) AS n FROM sync_vv").get()).toEqual({ n: rows.length });
    // The next write continues the sequence.
    db.exec(insertBlock("blk_next", "more"));
    expect(db.query("SELECT seq FROM sync_rows WHERE pk = 'blk_next'").get()).toEqual({ seq: rows.length + 1 });
  });

  test("two devices get different ids", () => {
    const ids = [0, 1].map(() => one(DeviceRow, migrated().query("SELECT device_id FROM sync_state").get()).device_id);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
