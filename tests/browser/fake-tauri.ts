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
import { hashInput, importsOf, isModuleName } from "../../src/lib/leanModel";

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

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/**
 * Lean, as a computer's Lean service would answer (src-tauri/src/lean/): a
 * line with `sorry` warns, a line with `#eval` prints, a line with
 * `type_mismatch` is an error; imports are followed through the book's
 * named Lean blocks; the verdict is saved like the real one.
 */
function fakeLeanCheck(db: Database, blockId: string, name: string, source: string) {
  const messages = source.split("\n").flatMap((l, line) => {
    const at = (word: string) => Math.max(0, l.indexOf(word));
    if (l.includes("type_mismatch")) return [{ severity: "error", line, column: at("type_mismatch"), endLine: line, endColumn: at("type_mismatch") + 13, text: "type mismatch" }];
    if (l.includes("sorry")) return [{ severity: "warning", line, column: at("sorry"), endLine: line, endColumn: at("sorry") + 5, text: "declaration uses 'sorry'" }];
    if (l.includes("#eval")) return [{ severity: "information", line, column: at("#eval"), endLine: line, endColumn: at("#eval") + 5, text: "2" }];
    return [];
  });
  const status = messages.some((m) => m.severity === "error") ? "errors" : messages.some((m) => m.severity === "warning") ? "sorry" : "verified";
  const rows = z
    .array(z.object({ id: z.string(), name: z.string().nullable(), source: z.string().nullable() }))
    .parse(db.query("SELECT id, json_extract(props, '$.name') AS name, json_extract(content, '$') AS source FROM blocks WHERE type = 'lean' AND deleted_at IS NULL ORDER BY id").all());
  const byName = new Map<string, string>();
  for (const r of rows) if (r.id !== blockId && r.name && isModuleName(r.name) && !byName.has(r.name)) byName.set(r.name, r.source ?? "");
  if (isModuleName(name)) byName.set(name, source);
  const seen = new Set<string>();
  const queue = importsOf(source);
  for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
    if (seen.has(n)) continue;
    seen.add(n);
    queue.push(...importsOf(byName.get(n) ?? ""));
  }
  const deps = [...seen].sort().flatMap((n) => {
    const s = byName.get(n);
    return s === undefined ? [] : [{ name: n, hash: sha256(hashInput(n, s)) }];
  });
  const verdict = {
    blockId,
    status,
    messages,
    sourceHash: sha256(hashInput(name, source)),
    deps,
    leanVersion: "leanprover/lean4:v4.99.0",
    device: "This computer",
    checkedAt: new Date().toISOString(),
  };
  db.query(
    "INSERT OR REPLACE INTO lean_checks (block_id, source_hash, deps, status, messages, lean_version, device, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(blockId, verdict.sourceHash, JSON.stringify(deps), status, JSON.stringify(messages), verdict.leanVersion, verdict.device, verdict.checkedAt);
  return verdict;
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
const workLog: { event: "begin" | "end"; id: string; title: string }[] = [];
const lanStarts: unknown[] = [];
let offerShown = false;
let running: { id: string; title: string; since: number }[] = [];

// Spec: LIB-23
/** arXiv, as its listing, PDF, HTML version and figures answer for 1706.03762 (and only it). */
const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
<title>Attention Is All You Need</title><summary>The dominant models.</summary>
<author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><author><name>Niki Parmar</name></author>
<author><name>Jakob Uszkoreit</name></author><author><name>Llion Jones</name></author></entry></feed>`;
const ARXIV_UNKNOWN = `<feed><entry><id>http://arxiv.org/api/errors#unknown</id><title>Error</title></entry></feed>`;
const filler = (what: string) => Array.from({ length: 14 }, (_, i) => `<p class="ltx_p">${what}, paragraph ${i + 1}: the encoder maps an input sequence to a sequence of continuous representations.</p>`).join("");
const ARXIV_HTML = `<!DOCTYPE html><html><head><title>Attention Is All You Need</title><script>window.evil = 1</script><link rel="stylesheet" href="ltx.css"></head>
<body><nav class="ltx_page_navbar">Contents navigation</nav><div class="ltx_page_main"><article class="ltx_document">
<div class="ltx_para">1]<span class="ltx_ERROR undefined">\\affillogo</span><object type="image/svg+xml" data="1706.03762v7/brain.svg">Google Brain</object> 2]<span class="ltx_ERROR undefined">\\affillogo</span></div>
<h1 class="ltx_title ltx_title_document">Attention Is All You Need</h1>
<div class="ltx_authors">Ashish Vaswani<span class="ltx_author_notes">Affiliation: [</span>, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones</div>
<section id="S1" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag">1 </span>Introduction</h2>
<p class="ltx_p">Recurrent models compute <math alttext="h_{t}" display="inline"><semantics><msub><mi>h</mi><mi>t</mi></msub><annotation encoding="application/x-tex">h_{t}</annotation></semantics></math> step by step.</p>
${filler("Introduction")}
<figure class="ltx_figure"><img src="1706.03762v7/x1.png" alt="The Transformer" style="width:598px;height:880px"><figcaption>Figure 1: The Transformer.</figcaption></figure>
<figure class="ltx_figure"><object type="image/svg+xml" data="1706.03762v7/x2.svg" aria-label="Attention heads" width="300" height="200">Attention heads</object><figcaption>Figure 2: Attention heads <span class="ltx_ERROR undefined">\\heads</span>.</figcaption></figure></section>
<section id="S2" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag">2 </span>Model</h2>${filler("Model")}
<section id="S2.SS1" class="ltx_subsection"><h3 class="ltx_title ltx_title_subsection"><span class="ltx_tag">2.1 </span>Attention</h3>
<p class="ltx_p" onclick="window.evil = 2">Scaled dot-product attention: <math display="block"><semantics><mi>A</mi><annotation encoding="application/x-tex">\\mathrm{softmax}(QK^{T})V</annotation></semantics></math></p>${filler("Attention")}</section></section>
<section id="bib" class="ltx_bibliography"><h2 class="ltx_title">References</h2><p>[1] Bahdanau et al.</p>${filler("References")}</section>
</article></div></body></html>`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#88a"/></svg>`;
// The smallest PNG: one transparent pixel.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

function fakeArxiv(url: string): { status: number; type: string; bytes: Uint8Array; url?: string } | null {
  const text = (s: string, type: string) => ({ status: 200, type, bytes: new TextEncoder().encode(s) });
  if (url.startsWith("https://export.arxiv.org/api/query")) return text(url.endsWith("1706.03762") ? ARXIV_FEED : ARXIV_UNKNOWN, "application/atom+xml");
  if (url === "https://arxiv.org/pdf/1706.03762")
    return { status: 200, type: "application/pdf", bytes: new Uint8Array(readFileSync(new URL("tests/browser/fixtures/with-contents.pdf", root))) };
  // As arXiv serves it: at the address asked for, its figures named from there (`1706.03762v7/x1.png`).
  if (url === "https://arxiv.org/html/1706.03762") return text(ARXIV_HTML, "text/html");
  if (url === "https://arxiv.org/html/1706.03762v7/x1.png") return { status: 200, type: "image/png", bytes: PNG };
  if (url === "https://arxiv.org/html/1706.03762v7/x2.svg") return text(SVG, "image/svg+xml");
  if (/^https:\/\/(arxiv\.org|ar5iv\.labs\.arxiv\.org|export\.arxiv\.org)\//.test(url)) return { status: 404, type: "text/plain", bytes: new TextEncoder().encode("Not Found") };
  return null;
}

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
    const arxiv = fakeArxiv(req?.url ?? "");
    if (arxiv) {
      const out = nextRid++;
      responses.set(out, { bytes: arxiv.bytes, sent: false });
      return { status: arxiv.status, statusText: arxiv.status === 200 ? "OK" : "Not Found", url: arxiv.url ?? req?.url ?? "", headers: [["content-type", arxiv.type]], rid: out };
    }
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
  const joins: { code: string; replace: boolean }[] = [];
  const fakeSyncStatus = (blocks: number) => ({
    deviceId: "dev_this",
    name: "This computer",
    platform: "linux",
    inBook: true,
    devices: [{ id: "dev_this", name: "This computer", platform: "linux", isSelf: true, lastSyncAt: null, lastCompleteAt: null, complete: false }],
    canJoin: blocks === 0,
    held: blocks === 0 ? [] : [{ table: "blocks", rows: blocks }],
    offerActive: false,
    syncing: false,
    lastError: null,
    lastRoundAt: null,
  });
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
      if (url.pathname === "/fake-joins") return Response.json(joins, { headers: cors });
      if (url.pathname === "/fake-work") return Response.json({ log: workLog, running }, { headers: cors });
      if (url.pathname === "/fake-lan") return Response.json(lanStarts, { headers: cors });
      if (url.pathname === "/query") {
        // For the checks: run SQL directly.
        const { sql } = z.object({ sql: z.string() }).parse(await req.json());
        return Response.json(db.query(sql).all(), { headers: cors });
      }
      const { cmd, args } = z.object({ cmd: z.string(), args: z.record(z.string(), z.unknown()) }).parse(await req.json());
      try {
        let out: unknown = null;
        if (cmd === "library_save_file") {
          // The PDF arrives as base64, as it does in the app.
          const bytes = Uint8Array.from(Buffer.from(String(args["data"]), "base64"));
          if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-")) return Response.json({ err: "the file isn't a PDF" }, { headers: cors });
          db.query("INSERT OR REPLACE INTO library_files (item_id, media_type, data) VALUES (?, ?, ?)").run(
            String(args["itemId"]),
            String(args["mediaType"] ?? "application/pdf"),
            bytes,
          );
          return Response.json({ ok: null }, { headers: cors });
        }
        if (cmd === "library_read_file") {
          const row = z.object({ data: z.instanceof(Uint8Array) }).optional().parse(
            db.query("SELECT data FROM library_files WHERE item_id = ?").get(String(args["itemId"])) ?? undefined,
          );
          if (!row) return Response.json({ err: "item has no PDF on this device" }, { headers: cors });
          return Response.json({ ok: Buffer.from(row.data).toString("base64") }, { headers: cors });
        }
        if (cmd.startsWith("plugin:http|")) return Response.json({ ok: httpCommand(cmd, args) }, { headers: cors });
        // Sync, enough for the pairing screen: a device that holds a book, a
        // code as long as a real one, and joins recorded for the checks.
        // Spec: AUD-6, AUD-7
        // The Rust job, as if it had spoken the script: the fixture our encoder made, its chapters spread over it.
        if (cmd === "audio_render") {
          const id = String(args["id"]);
          const row = z.object({ script: z.string() }).parse(db.query("SELECT script FROM recordings WHERE id = ?").get(id));
          const script = z.object({ chapters: z.array(z.object({ title: z.string() })) }).parse(parseJson(row.script));
          const chapters = script.chapters.map((c, i) => ({ title: c.title, start: (i * 3) / Math.max(1, script.chapters.length) }));
          const webm = new Uint8Array(readFileSync(new URL("tests/browser/fixtures/speech.webm", root)));
          db.query("INSERT OR REPLACE INTO recording_files (recording_id, media_type, data) VALUES (?, 'audio/webm', ?)").run(id, webm);
          db.query("UPDATE recordings SET status = 'ready', progress = 1, chapters = ?, duration_seconds = 3 WHERE id = ?").run(JSON.stringify(chapters), id);
          return Response.json({ ok: null }, { headers: cors });
        }
        if (cmd === "audio_read") {
          const row = z.object({ data: z.instanceof(Uint8Array) }).optional().parse(db.query("SELECT data FROM recording_files WHERE recording_id = ?").get(String(args["id"])) ?? undefined);
          if (!row) return Response.json({ err: "this recording hasn't reached this device yet" }, { headers: cors });
          return Response.json({ ok: Buffer.from(row.data).toString("base64") }, { headers: cors });
        }
        if (cmd === "lean_status") {
          return Response.json({ ok: { lake: "/home/fake/.elan/bin/lake", ready: true, toolchain: "leanprover/lean4:v4.99.0", settingUp: false, workspace: "/fake/lean" } }, { headers: cors });
        }
        if (cmd === "lean_check") {
          return Response.json({ ok: fakeLeanCheck(db, String(args["blockId"]), String(args["name"]), String(args["source"])) }, { headers: cors });
        }
        if (cmd === "lean_goal") {
          return Response.json({ ok: { goals: ["n : ℕ\n⊢ n + 0 = n"], term: null } }, { headers: cors });
        }
        if (cmd === "sync_status") {
          const pages = z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM blocks").get());
          return Response.json({ ok: fakeSyncStatus(pages.n) }, { headers: cors });
        }
        // Spec: tandem.SYN-5, tandem.SYN-25
        // The LAN plugin as a computer runs it: what's announced is recorded for the checks.
        if (cmd === "plugin:lan|is_mobile") return Response.json({ ok: false }, { headers: cors });
        if (cmd === "plugin:lan|start") {
          lanStarts.push(args["config"]);
          return Response.json({ ok: null }, { headers: cors });
        }
        if (cmd === "sync_announce") {
          return Response.json(
            { ok: { serviceName: "Commonplace-fake", port: 47832, deviceId: "dev-fake", book: "bookfaketag", pair: offerShown ? "pairfaketag" : "" } },
            { headers: cors },
          );
        }
        if (cmd === "sync_cancel_offer") {
          offerShown = false;
          return Response.json({ ok: null }, { headers: cors });
        }
        if (cmd === "sync_offer") {
          offerShown = true;
          const body = Buffer.from(Array.from({ length: 230 }, (_, i) => (i * 97 + 13) % 256)).toString("base64url");
          return Response.json({ ok: `mybook-pair:1:${body}` }, { headers: cors });
        }
        // Spec: tandem.SYN-23
        // As a Mac the system keeps off the local network finds it.
        if (cmd === "sync_check") {
          return Response.json(
            {
              ok: {
                verdict:
                  "macOS is keeping Commonplace off the local network. Open System Settings → Privacy & Security → Local Network and turn Commonplace on, then try again.",
                fix: "local-network",
                lines: [
                  { ok: true, text: "This device is on the local network as 192.168.1.20/24 (en0)." },
                  { ok: true, text: "Sync listens on TCP port 47832; devices search on UDP port 47831." },
                  { ok: false, text: "Phone at 192.168.1.44:47832: No route to host (os error 65) after 2 ms, sent from 192.168.1.20 (en0)" },
                ],
              },
            },
            { headers: cors },
          );
        }
        if (cmd === "sync_join") {
          joins.push({ code: String(args["code"]), replace: args["replace"] === true });
          const outcome = { peer_id: "dev_other", peer_name: "The other device", received: { applied: 0, conflicts: 0, unique_merges: 0 }, complete: true, differences: [] };
          return Response.json({ ok: { outcome, backup: args["replace"] === true ? "/backups/before-join.db" : null } }, { headers: cors });
        }
        // Spec: WORK-1, DIAG-3
        // Work as Rust keeps it, every begin and end recorded for the checks.
        if (cmd === "work_begin") {
          const id = String(args["id"]);
          const title = String(args["title"]);
          workLog.push({ event: "begin", id, title });
          const at = running.findIndex((r) => r.id === id);
          if (at >= 0) running[at] = { id, title, since: running[at]?.since ?? Date.now() };
          else running.push({ id, title, since: Date.now() });
          return Response.json({ ok: null }, { headers: cors });
        }
        if (cmd === "work_end") {
          const id = String(args["id"]);
          workLog.push({ event: "end", id, title: running.find((r) => r.id === id)?.title ?? "" });
          running = running.filter((r) => r.id !== id);
          return Response.json({ ok: null }, { headers: cors });
        }
        if (cmd === "work_running") return Response.json({ ok: running }, { headers: cors });
        if (cmd === "plugin:app|version") return Response.json({ ok: "0.1.0" }, { headers: cors });
        if (cmd === "plugin:app|identifier") return Response.json({ ok: "com.madsbuch.commonplace.dev" }, { headers: cors });
        if (cmd === "plugin:app|tauri_version") return Response.json({ ok: "2.99.0" }, { headers: cors });
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
