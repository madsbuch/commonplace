// Stands in for the Tauri side when the app runs in a plain browser (the
// browser checks in tests/browser/): a small HTTP server that answers the
// SQL plugin's commands from a real SQLite database with the app's
// migrations applied. Other commands answer null.
//
//   bun tests/browser/fake-tauri.ts [db-path]    # listens on FAKE_TAURI_PORT (1430)

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseJson, ScriptSchema } from "../../src/lib/schemas";
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
  // `cut`: the answer stops at its most (finish_reason "length").
  z.object({ text: z.string(), cut: z.boolean().optional() }),
  z.object({ tools: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })) }),
  z.object({ error: z.string() }),
]);
let chatReplies: z.infer<typeof ReplySchema>[] = [];
const workLog: { event: "begin" | "end"; id: string; title: string }[] = [];
const lanStarts: unknown[] = [];
// Spec: LIB-30
// What the checks shared to the app, until it takes it (`plugin:share-target|take`).
const sharesWaiting: unknown[] = [];
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

// Spec: LIB-28
/** Two blogs: one that serves its posts as HTML, one whose pages build themselves (an empty shell until rendered). */
const postText = (what: string) =>
  Array.from({ length: 6 }, (_, i) => `<p>${what}, paragraph ${i + 1}: a compiler turns what people write into what machines run, and a good one says where it went wrong.</p>`).join("");
const STATIC_POST = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>On Compilers | Example Blog</title>
<meta property="og:title" content="On Compilers"><meta property="og:site_name" content="Example Blog">
<meta property="article:published_time" content="2024-03-01T09:00:00Z"><script>window.evil = 1</script></head>
<body><nav class="site-nav"><a href="/">Home</a> <a href="/archive">Archive</a> <a href="/about">About</a></nav>
<header><a href="/">Example Blog</a></header>
<main><article><h1>On Compilers</h1><p class="byline">By <span class="author">Grace Hopper and Ada Lovelace</span></p>
${postText("Why")}
<h2>Front ends</h2>${postText("Parsing")}
<figure><img src="/images/fig.png" alt="A parse tree"><figcaption>Figure 1: A parse tree.</figcaption></figure>
<p>Its cost is <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>O</mi><mo>(</mo><mi>n</mi><mo>)</mo></mrow><annotation encoding="application/x-tex">O(n)</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">O(n) drawn</span></span> in the input.</p>
<video src="/media/talk.mp4" controls></video>
<h2>Back ends</h2>${postText("Emitting")}</article></main>
<aside class="related"><h3>Related posts</h3><a href="/other">Another post</a></aside>
<footer>© 2024 Example Blog · <a href="/privacy">Privacy</a></footer></body></html>`;
const SHELL_POST = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta property="og:title" content="Loops All the Way"><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>`;
const RENDERED_POST = `<html><head><meta property="og:title" content="Loops All the Way"><title>Loops All the Way</title></head><body><div id="root">
<div class="top"><div>2026-11-23 · Research</div><h1><p>Spa 2: Loops All the Way</p></h1></div>
<div class="body">${postText("Looping")}<h1>The loop</h1><div><img src="https://cdn.example.org/loop.png" alt=""></div>${postText("Gates")}</div>
<footer>Legal · Privacy</footer></div></body></html>`;
const webRenders: string[] = [];

function fakeWeb(url: string): { status: number; contentType: string; url: string; data: string } | null {
  const ok = (body: string | Uint8Array, contentType: string, at = url) => ({
    status: 200,
    contentType,
    url: at,
    data: Buffer.from(typeof body === "string" ? new TextEncoder().encode(body) : body).toString("base64"),
  });
  // Served at its address with a trailing slash, as many blogs redirect.
  if (url === "https://blog.example.com/posts/on-compilers") return ok(STATIC_POST, "text/html; charset=utf-8", `${url}/`);
  if (url === "https://blog.example.com/images/fig.png") return ok(PNG, "image/png");
  if (url === "https://spa.example.com/blog/loops") return ok(SHELL_POST, "text/html");
  if (url === "https://cdn.example.org/loop.png") return ok(PNG, "image/png");
  // Spec: LIB-29
  // A PDF, served as some servers do, as anything at all.
  if (url === "https://papers.example.com/files/on-loops.pdf")
    return ok(new Uint8Array(readFileSync(new URL("tests/browser/fixtures/with-contents.pdf", root))), "application/octet-stream");
  if (url === "https://blog.example.com/missing") return { status: 404, contentType: "text/html", url, data: Buffer.from("Not Found").toString("base64") };
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
  out += ev({ choices: [{ delta: {}, finish_reason: "text" in reply && reply.cut ? "length" : "stop" }], usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0004 } });
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
      if (url.pathname === "/fake-share") {
        sharesWaiting.push(await req.json());
        return Response.json({ ok: true }, { headers: cors });
      }
      if (url.pathname === "/fake-web") return Response.json(webRenders, { headers: cors });
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
        // Spec: LIB-28
        // Rust's fetch and render, for the two blogs above; nowhere else answers.
        if (cmd === "web_get") {
          const got = fakeWeb(String(args["url"]));
          if (!got) return Response.json({ err: `couldn't fetch ${String(args["url"])}: dns error` }, { headers: cors });
          return Response.json({ ok: got }, { headers: cors });
        }
        if (cmd === "web_render") {
          const url = String(args["url"]);
          webRenders.push(url);
          if (url === "https://spa.example.com/blog/loops") return Response.json({ ok: { html: RENDERED_POST, url } }, { headers: cors });
          return Response.json({ err: `${url} didn't finish loading in 30 s` }, { headers: cors });
        }
        // Sync, enough for the pairing screen: a device that holds a book, a
        // code as long as a real one, and joins recorded for the checks.
        // Spec: AUD-6, AUD-7, AUD-13
        // Rust's maker, as if it had written and spoken: from where the listener
        // is, each chunk not yet written is written (the request the script
        // model would get is recorded, the scripted answer taken), and the fake's
        // lead, the piece listened at and the one after, is spoken, a piece
        // each: the fixture our encoder made. All of it, when asked for at once.
        if (cmd === "audio_listen" || cmd === "audio_make_all") {
          const id = String(args["id"]);
          const all = cmd === "audio_make_all";
          const row = z
            .object({ script: z.string().nullable(), status: z.string(), voice: z.string(), speech_model: z.string() })
            .optional()
            .parse(db.query("SELECT script, status, voice, speech_model FROM recordings WHERE id = ?").get(id) ?? undefined);
          if (!row?.script) return Response.json({ ok: null }, { headers: cors });
          const script = ScriptSchema.parse(parseJson(row.script));
          const at = typeof args["piece"] === "string" ? args["piece"].split(".").slice(-3).map(Number) : [0, 0, 0];
          const prompt = readFileSync(new URL("src-tauri/src/audio/verbatim.md", root), "utf8");
          const webm = new Uint8Array(readFileSync(new URL("tests/browser/fixtures/speech.webm", root)));
          // Spec: AUD-14
          // Chunks another recording wrote already, by their source.
          const elsewhere = new Map<string, string[]>();
          for (const other of z.array(z.object({ script: z.string() })).parse(db.query("SELECT script FROM recordings WHERE id != ? AND script IS NOT NULL").all(id))) {
            const s = ScriptSchema.safeParse(parseJson(other.script));
            if (s.success) for (const ch of s.data.chapters) for (const k of ch.chunks ?? []) if (k.source !== undefined && k.passages) elsewhere.set(k.source, k.passages);
          }
          const write = (k: { source?: string; passages: string[] | null; model?: string }) => {
            const before = k.source === undefined ? undefined : elsewhere.get(k.source);
            if (before) {
              k.passages = before;
              return;
            }
            chatRequests.push({ model: "anthropic/claude-haiku-5.5", messages: [{ role: "system", content: prompt }, { role: "user", content: k.source ?? "" }], max_tokens: 16000 });
            const answer = z.object({ paragraphs: z.array(z.string()) }).safeParse(modelAnswer);
            k.passages = answer.success ? answer.data.paragraphs : [];
            k.model = "anthropic/claude-haiku-5.5";
          };
          type Place = { c: number; k: number; n: number | null; text: string };
          const places = (): Place[] =>
            script.chapters.flatMap((ch, c) =>
              (ch.chunks ?? []).flatMap((k, i): Place[] => (k.passages === null ? [{ c, k: i, n: null, text: "" }] : k.passages.map((text, n) => ({ c, k: i, n, text })))),
            );
          let order = places();
          const from = Math.max(0, order.findIndex((p) => p.c === at[0] && p.k === at[1] && (p.n === null || p.n === at[2])));
          // Written as it's reached: from the listener on, until the fake's lead (two passages) is written; all of it, at once.
          let ahead = 0;
          for (let i = all ? 0 : from; i < order.length && (all || ahead < 2); ) {
            const p = order[i];
            if (p && p.n === null) {
              const chunk = script.chapters[p.c]?.chunks?.[p.k];
              if (chunk) write(chunk);
              order = places();
              continue;
            }
            ahead += 1;
            i += 1;
          }
          db.query("UPDATE recordings SET script = ? WHERE id = ?").run(JSON.stringify(script), id);
          const spoken = order.filter((p) => p.n !== null);
          const start = Math.max(0, spoken.findIndex((p) => p.c === at[0] && p.k === at[1] && (p.n === at[2] || at[2] === 0)));
          for (const p of all ? spoken : spoken.slice(start, start + 2)) {
            db.query("INSERT OR IGNORE INTO recording_pieces (id, recording_id, chapter, chunk, passage, seconds, data, created_at, speech_key) VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?)").run(
              `${id}.${p.c}.${p.k}.${p.n ?? 0}`,
              id,
              p.c,
              p.k,
              p.n ?? 0,
              webm,
              new Date().toISOString(),
              `${row.speech_model}|${row.voice}|${p.text}`,
            );
          }
          const made = z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM recording_pieces WHERE recording_id = ?").get(id)).n;
          const done = order.every((p) => p.n !== null) && made >= order.length;
          db.query("UPDATE recordings SET status = ?, progress = ? WHERE id = ?").run(done ? "ready" : all ? "making" : row.status, order.length ? made / order.length : 1, id);
          return Response.json({ ok: null }, { headers: cors });
        }
        // Spec: AUD-18
        // A chapter made now: its chunks written, its passages spoken.
        if (cmd === "audio_make_chapter") {
          const id = String(args["id"]);
          const chapter = z.number().parse(args["chapter"]);
          const row = z.object({ script: z.string(), voice: z.string(), speech_model: z.string() }).parse(db.query("SELECT script, voice, speech_model FROM recordings WHERE id = ?").get(id));
          const script = ScriptSchema.parse(parseJson(row.script));
          const webm = new Uint8Array(readFileSync(new URL("tests/browser/fixtures/speech.webm", root)));
          const prompt = readFileSync(new URL("src-tauri/src/audio/verbatim.md", root), "utf8");
          (script.chapters[chapter]?.chunks ?? []).forEach((k, i) => {
            if (k.passages === null) {
              chatRequests.push({ model: "anthropic/claude-haiku-5.5", messages: [{ role: "system", content: prompt }, { role: "user", content: k.source ?? "" }], max_tokens: 16000 });
              const answer = z.object({ paragraphs: z.array(z.string()) }).safeParse(modelAnswer);
              k.passages = answer.success ? answer.data.paragraphs : [];
            }
            k.passages.forEach((text, n) =>
              db.query("INSERT OR IGNORE INTO recording_pieces (id, recording_id, chapter, chunk, passage, seconds, data, created_at, speech_key) VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?)").run(
                `${id}.${chapter}.${i}.${n}`,
                id,
                chapter,
                i,
                n,
                webm,
                new Date().toISOString(),
                `${row.speech_model}|${row.voice}|${text}`,
              ),
            );
          });
          db.query("UPDATE recordings SET script = ? WHERE id = ?").run(JSON.stringify(script), id);
          return Response.json({ ok: null }, { headers: cors });
        }
        // Spec: AUD-17
        // Rust's lay_over: the script afresh, the pieces where their passages now are, where it was left after its piece.
        if (cmd === "audio_reshape") {
          const id = String(args["id"]);
          const script = ScriptSchema.parse(parseJson(String(args["script"])));
          const row = z.object({ voice: z.string(), speech_model: z.string() }).parse(db.query("SELECT voice, speech_model FROM recordings WHERE id = ?").get(id));
          const kept = z.array(z.object({ id: z.string(), speech_key: z.string().nullable(), data: z.instanceof(Uint8Array) })).parse(db.query("SELECT id, speech_key, data FROM recording_pieces WHERE recording_id = ?").all(id));
          const at = z.object({ piece: z.string().nullable() }).optional().parse(db.query("SELECT piece FROM listening WHERE recording_id = ?").get(id) ?? undefined);
          const wasAt = kept.find((k) => k.id === at?.piece)?.speech_key ?? null;
          db.query("UPDATE recordings SET script = ? WHERE id = ?").run(JSON.stringify(script), id);
          db.query("DELETE FROM recording_pieces WHERE recording_id = ?").run(id);
          let nowAt: string | null = null;
          script.chapters.forEach((ch, c) =>
            (ch.chunks ?? []).forEach((k, i) =>
              (k.passages ?? []).forEach((text, n) => {
                const key = `${row.speech_model}|${row.voice}|${text}`;
                const piece = kept.find((p) => p.speech_key === key);
                if (key === wasAt) nowAt ??= `${id}.${c}.${i}.${n}`;
                if (piece)
                  db.query("INSERT OR IGNORE INTO recording_pieces (id, recording_id, chapter, chunk, passage, seconds, data, created_at, speech_key) VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?)").run(
                    `${id}.${c}.${i}.${n}`,
                    id,
                    c,
                    i,
                    n,
                    piece.data,
                    new Date().toISOString(),
                    key,
                  );
              }),
            ),
          );
          // What isn't placed waits, kept aside, for its chunk to be written again.
          const placed = new Set(script.chapters.flatMap((ch) => (ch.chunks ?? []).flatMap((k) => (k.passages ?? []).map((text) => `${row.speech_model}|${row.voice}|${text}`))));
          for (const p of kept)
            if (p.speech_key && !placed.has(p.speech_key))
              db.query("INSERT OR REPLACE INTO recording_pieces (id, recording_id, chapter, chunk, passage, seconds, data, created_at, speech_key) VALUES (?, ?, -1, -1, -1, 3, ?, ?, ?)").run(
                `${id}.parked.${p.speech_key.slice(-32)}`,
                id,
                p.data,
                new Date().toISOString(),
                p.speech_key,
              );
          if (nowAt) db.query("UPDATE listening SET piece = ? WHERE recording_id = ?").run(nowAt, id);
          else db.query("DELETE FROM listening WHERE recording_id = ?").run(id);
          return Response.json({ ok: null }, { headers: cors });
        }
        // Spec: AUD-14
        // Rust's take_in: an item's earlier recordings' chunks and pieces into its reading, then they go.
        if (cmd === "audio_adopt") {
          const reading = String(args["reading"]);
          const old = z.array(z.string()).parse(args["old"]).filter((o) => o !== reading);
          const rr = z.object({ script: z.string(), voice: z.string(), speech_model: z.string() }).parse(db.query("SELECT script, voice, speech_model FROM recordings WHERE id = ?").get(reading));
          const script = ScriptSchema.parse(parseJson(rr.script));
          const written = new Map<string, string[]>();
          for (const o of old) {
            const r = z.object({ script: z.string().nullable() }).optional().parse(db.query("SELECT script FROM recordings WHERE id = ?").get(o) ?? undefined);
            const s = r?.script ? ScriptSchema.safeParse(parseJson(r.script)) : null;
            if (s?.success) for (const ch of s.data.chapters) for (const k of ch.chunks ?? []) if (k.source !== undefined && k.passages) written.set(k.source, k.passages);
          }
          script.chapters.forEach((ch) => (ch.chunks ?? []).forEach((k) => {
            const before = k.source === undefined ? undefined : written.get(k.source);
            if (k.passages === null && before) k.passages = before;
          }));
          db.query("UPDATE recordings SET script = ? WHERE id = ?").run(JSON.stringify(script), reading);
          script.chapters.forEach((ch, c) =>
            (ch.chunks ?? []).forEach((k, i) =>
              (k.passages ?? []).forEach((text, n) => {
                const piece = z.object({ data: z.instanceof(Uint8Array) }).optional().parse(
                  db.query("SELECT data FROM recording_pieces WHERE speech_key = ? LIMIT 1").get(`${rr.speech_model}|${rr.voice}|${text}`) ?? undefined,
                );
                if (piece)
                  db.query("INSERT OR IGNORE INTO recording_pieces (id, recording_id, chapter, chunk, passage, seconds, data, created_at, speech_key) VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?)").run(
                    `${reading}.${c}.${i}.${n}`,
                    reading,
                    c,
                    i,
                    n,
                    piece.data,
                    new Date().toISOString(),
                    `${rr.speech_model}|${rr.voice}|${text}`,
                  );
              }),
            ),
          );
          for (const o of old) for (const sql of ["DELETE FROM recording_pieces WHERE recording_id = ?", "DELETE FROM listening WHERE recording_id = ?", "DELETE FROM recordings WHERE id = ?"]) db.query(sql).run(o);
          return Response.json({ ok: null }, { headers: cors });
        }
        if (cmd === "audio_piece") {
          const row = z.object({ data: z.instanceof(Uint8Array) }).optional().parse(db.query("SELECT data FROM recording_pieces WHERE id = ?").get(String(args["id"])) ?? undefined);
          if (!row) return Response.json({ err: "this part of the recording hasn't reached this device yet" }, { headers: cors });
          return Response.json({ ok: Buffer.from(row.data).toString("base64") }, { headers: cors });
        }
        if (cmd === "audio_forget") return Response.json({ ok: null }, { headers: cors });
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
        // Spec: LIB-30
        // The share sheet's plugin: what the checks shared, taken once.
        if (cmd === "plugin:share-target|take") return Response.json({ ok: { shares: sharesWaiting.splice(0) } }, { headers: cors });
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
