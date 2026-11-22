import Database from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { deviceSettings, settings } from "../db/schema";
import { DEVICE_SETTING_KEYS } from "./settings";
import { notifyTablesChanged, writtenTable } from "./live";
import { parseSqlRows } from "./schemas";

const DB_URL = "sqlite:book.db";

/** Hooks run once the database is open, before anything else touches it. */
const openHooks: ((conn: Database) => Promise<void>)[] = [];

/** Runs `hook` when the database first opens (before any query). Call at module load. */
export function onDatabaseOpen(hook: (conn: Database) => Promise<void>): void {
  openHooks.push(hook);
}

let sqlitePromise: Promise<Database> | null = null;

function sqlite(): Promise<Database> {
  sqlitePromise ??= Database.load(DB_URL).then(async (conn) => {
    for (const hook of openHooks) {
      try {
        await hook(conn);
      } catch (e) {
        console.warn("A database open hook failed", e);
      }
    }
    return conn;
  });
  return sqlitePromise;
}

/** Warm the connection (runs pending migrations on the Rust side). */
export function getDb(): Promise<Database> {
  return sqlite();
}

/**
 * Drizzle over tauri-plugin-sql: SQL executes in the Rust process (sqlx);
 * this proxy only ships query strings and params over IPC.
 *
 * Row mapping is positional: serde_json's `preserve_order` feature is enabled
 * in src-tauri/Cargo.toml so object key order matches the SELECT column order.
 */
export const db = drizzle(async (query, params, method) => {
  const conn = await sqlite();
  if (method === "run") {
    await conn.execute(query, params);
    await noteWrite(conn, query);
    return { rows: [] };
  }
  const rows = parseSqlRows(await conn.select(query, params));
  await noteWrite(conn, query);
  const values = rows.map((r) => Object.values(r));
  return { rows: method === "get" ? (values[0] ?? []) : values };
});

/** Raw SQL, for what drizzle can't say. Writes announce their table like drizzle's. */
export async function execute(query: string, params: unknown[] = []): Promise<void> {
  const conn = await sqlite();
  await conn.execute(query, params);
  await noteWrite(conn, query);
}

/** Raw SELECT; rows still to be parsed. */
export async function select(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const conn = await sqlite();
  return parseSqlRows(await conn.select(query, params));
}

/** Sync's change counter as last seen here (see `noteWrite`). */
let lastSeq: number | null = null;

/**
 * Tells the screens (lib/live.ts) that a write changed `query`'s table, when
 * it really changed something. The sync triggers bump `sync_state.seq` only
 * for a real change to a synced table, so a write that changed nothing wakes
 * nobody. Before sync exists (no `sync_state`), every write counts.
 */
async function noteWrite(conn: Database, query: string): Promise<void> {
  const table = writtenTable(query);
  if (!table) return;
  try {
    const rows = parseSqlRows(await conn.select("SELECT seq FROM sync_state WHERE id = 1"));
    const raw = rows[0]?.["seq"];
    const seq = typeof raw === "number" ? raw : null;
    if (seq === null) {
      notifyTablesChanged([table]);
    } else if (lastSeq === null || seq > lastSeq) {
      lastSeq = seq;
      notifyTablesChanged([table]);
    }
  } catch {
    notifyTablesChanged([table]);
  }
}

/** Now, as the app writes timestamps: UTC ISO 8601, to the millisecond. */
export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The table a key lives in: this device's own, or the book's (synced). */
function settingsTable(key: string) {
  return DEVICE_SETTING_KEYS.has(key) ? deviceSettings : settings;
}

export async function getSetting(key: string): Promise<string | null> {
  const t = settingsTable(key);
  const rows = await db.select({ value: t.value }).from(t).where(eq(t.key, key));
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const t = settingsTable(key);
  await db.insert(t).values({ key, value }).onConflictDoUpdate({ target: t.key, set: { value } });
}

export async function deleteSetting(key: string): Promise<void> {
  const t = settingsTable(key);
  await db.delete(t).where(eq(t.key, key));
}
