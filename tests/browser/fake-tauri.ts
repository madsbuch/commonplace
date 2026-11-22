// Stands in for the Tauri side when the app runs in a plain browser (the
// browser checks in tests/browser/): a small HTTP server that answers the
// SQL plugin's commands from a real SQLite database with the app's
// migrations applied. Other commands answer null.
//
//   bun tests/browser/fake-tauri.ts [db-path]    # listens on FAKE_TAURI_PORT (1430)

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";

const PORT = Number(process.env["FAKE_TAURI_PORT"] ?? 1430);
const root = new URL("../../", import.meta.url);

export function openBookDb(path: string): Database {
  const db = new Database(path, { create: true });
  const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
  db.exec("CREATE TABLE IF NOT EXISTS _fake_migrations (name TEXT PRIMARY KEY)");
  for (const m of rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)) {
    const name = m[1] ?? "";
    if (db.query("SELECT 1 FROM _fake_migrations WHERE name = ?").get(name)) continue;
    const sql = readFileSync(new URL(`src-tauri/migrations/${name}`, root), "utf8");
    db.exec(sql.replaceAll("--> statement-breakpoint", ""));
    db.query("INSERT INTO _fake_migrations (name) VALUES (?)").run(name);
  }
  return db;
}

/** sqlx's `$1` placeholders, as bun:sqlite's `?1`. */
const positional = (q: string) => q.replace(/\$(\d+)/g, "?$1");

type Bindable = string | number | bigint | boolean | null;
function bindable(values: unknown): Bindable[] {
  if (!Array.isArray(values)) return [];
  return values.map((v): Bindable => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return v;
    return JSON.stringify(v);
  });
}

if (import.meta.main) {
  const db = openBookDb(process.argv[2] ?? ":memory:");
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" };
  Bun.serve({
    port: PORT,
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { headers: cors });
      const url = new URL(req.url);
      if (url.pathname === "/query") {
        // For the checks: run SQL directly.
        const { sql } = z.object({ sql: z.string() }).parse(await req.json());
        return Response.json(db.query(sql).all(), { headers: cors });
      }
      const { cmd, args } = z.object({ cmd: z.string(), args: z.record(z.string(), z.unknown()) }).parse(await req.json());
      try {
        let out: unknown = null;
        if (cmd === "plugin:sql|load") out = args["db"];
        else if (cmd === "plugin:sql|execute") {
          const r = db.query(positional(String(args["query"]))).run(...bindable(args["values"]));
          out = [r.changes, Number(r.lastInsertRowid)];
        } else if (cmd === "plugin:sql|select") {
          out = db.query(positional(String(args["query"]))).all(...bindable(args["values"]));
        }
        return Response.json({ ok: out }, { headers: cors });
      } catch (e) {
        return Response.json({ err: String(e) }, { headers: cors });
      }
    },
  });
  console.log(`fake tauri on :${PORT}`);
}
