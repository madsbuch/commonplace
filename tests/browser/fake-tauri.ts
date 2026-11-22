// Stands in for the Tauri side when the app runs in a plain browser (the
// browser checks in tests/browser/): a small HTTP server that answers the
// SQL plugin's commands from a real SQLite database with the app's
// migrations applied. Other commands answer null.
//
//   bun tests/browser/fake-tauri.ts [db-path]    # listens on FAKE_TAURI_PORT (1430)

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseJson } from "../../src/lib/schemas";

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

/**
 * Tauri's HTTP plugin, stood in for: requests to OpenRouter get canned
 * answers (the model's reply set with POST /fake-model), and every chat
 * request is kept for the checks to read (GET /fake-requests).
 */
interface PendingResponse {
  bytes: Uint8Array;
  sent: boolean;
}
const requests = new Map<number, { url: string; body: string }>();
const responses = new Map<number, PendingResponse>();
const chatRequests: unknown[] = [];
let modelAnswer: unknown = { title: "A title", authors: [], year: null, kind: "paper" };

/** Scripted replies for streamed chat rounds, taken in order (POST /fake-chat). */
const ReplySchema = z.union([
  z.object({ text: z.string() }),
  z.object({ tools: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })) }),
  z.object({ error: z.string() }),
]);
let chatReplies: z.infer<typeof ReplySchema>[] = [];

/** One streamed round as server-sent events, the way OpenRouter sends it. */
function sse(reply: z.infer<typeof ReplySchema>): string {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  let out = ": OPENROUTER PROCESSING\n\n";
  if ("text" in reply) {
    // In two pieces, as a stream would.
    const half = Math.ceil(reply.text.length / 2);
    out += ev({ choices: [{ delta: { content: reply.text.slice(0, half) } }] });
    out += ev({ choices: [{ delta: { content: reply.text.slice(half) } }] });
  } else if ("tools" in reply) {
    reply.tools.forEach((c, index) => {
      const args = JSON.stringify(c.arguments ?? {});
      out += ev({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}_${Date.now()}`, type: "function", function: { name: c.name, arguments: args.slice(0, 3) } }] } }] });
      out += ev({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(3) } }] } }] });
    });
  }
  out += ev({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0004 } });
  return out + "data: [DONE]\n\n";
}
let nextRid = 1;

function httpCommand(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === "plugin:http|fetch") {
    const config = z.object({ url: z.string(), data: z.array(z.number()).nullable().optional() }).parse(args["clientConfig"]);
    const rid = nextRid++;
    requests.set(rid, { url: config.url, body: config.data ? new TextDecoder().decode(Uint8Array.from(config.data)) : "" });
    return rid;
  }
  if (cmd === "plugin:http|fetch_send") {
    const rid = z.number().parse(args["rid"]);
    const req = requests.get(rid);
    let body: unknown = { data: [] };
    if (req?.url.endsWith("/chat/completions") && req.body.includes('"stream":true')) {
      chatRequests.push(parseJson(req.body));
      const reply = chatReplies.shift() ?? { text: "(no scripted reply)" };
      const out = nextRid++;
      if ("error" in reply) {
        responses.set(out, { bytes: new TextEncoder().encode(JSON.stringify({ error: { message: reply.error } })), sent: false });
        return { status: 400, statusText: "Bad Request", url: req.url, headers: [["content-type", "application/json"]], rid: out };
      }
      responses.set(out, { bytes: new TextEncoder().encode(sse(reply)), sent: false });
      return { status: 200, statusText: "OK", url: req.url, headers: [["content-type", "text/event-stream"]], rid: out };
    }
    if (req?.url.endsWith("/chat/completions")) {
      const sent = parseJson(req.body);
      chatRequests.push(sent);
      body = {
        choices: [{ message: { content: JSON.stringify(modelAnswer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.00016 },
      };
    }
    const out = nextRid++;
    responses.set(out, { bytes: new TextEncoder().encode(JSON.stringify(body)), sent: false });
    return { status: 200, statusText: "OK", url: req?.url ?? "", headers: [["content-type", "application/json"]], rid: out };
  }
  if (cmd === "plugin:http|fetch_read_body") {
    const r = responses.get(z.number().parse(args["rid"]));
    if (!r || r.sent) return [1];
    r.sent = true;
    return [...r.bytes, 0];
  }
  return null;
}

if (import.meta.main) {
  const db = openBookDb(process.argv[2] ?? ":memory:");
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-item-id, x-media-type" };
  Bun.serve({
    port: PORT,
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { headers: cors });
      const url = new URL(req.url);
      if (url.pathname === "/raw") {
        // A command whose argument is raw bytes (Tauri's binary IPC body).
        const cmd = url.searchParams.get("cmd");
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (cmd === "library_save_file") {
          const head = new TextDecoder().decode(bytes.slice(0, 1024));
          if (!head.includes("%PDF-")) return Response.json({ err: "the file isn't a PDF" }, { headers: cors });
          db.query("INSERT OR REPLACE INTO library_files (item_id, media_type, data) VALUES (?, ?, ?)").run(
            req.headers.get("x-item-id"),
            req.headers.get("x-media-type") ?? "application/pdf",
            bytes,
          );
          return Response.json({ ok: null }, { headers: cors });
        }
        return Response.json({ err: `no raw command ${cmd ?? ""}` }, { headers: cors });
      }
      if (url.pathname === "/fake-model") {
        modelAnswer = z.object({ answer: z.unknown() }).parse(await req.json()).answer;
        return Response.json({ ok: true }, { headers: cors });
      }
      if (url.pathname === "/fake-chat") {
        chatReplies = z.object({ replies: z.array(ReplySchema) }).parse(await req.json()).replies;
        return Response.json({ ok: true }, { headers: cors });
      }
      if (url.pathname === "/fake-requests") return Response.json(chatRequests, { headers: cors });
      if (url.pathname === "/query") {
        // For the checks: run SQL directly.
        const { sql } = z.object({ sql: z.string() }).parse(await req.json());
        return Response.json(db.query(sql).all(), { headers: cors });
      }
      const { cmd, args } = z.object({ cmd: z.string(), args: z.record(z.string(), z.unknown()) }).parse(await req.json());
      try {
        let out: unknown = null;
        if (cmd === "library_read_file") {
          // Answered as raw bytes, as tauri::ipc::Response is.
          const row = z.object({ data: z.instanceof(Uint8Array) }).optional().parse(
            db.query("SELECT data FROM library_files WHERE item_id = ?").get(String(args["itemId"])) ?? undefined,
          );
          if (!row) return Response.json({ err: "no PDF on this device" }, { headers: cors });
          return new Response(row.data, { headers: { ...cors, "content-type": "application/octet-stream" } });
        }
        if (cmd.startsWith("plugin:http|")) return Response.json({ ok: httpCommand(cmd, args) }, { headers: cors });
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
