// Drives the book in Chromium against a real SQLite database: the app in the
// Vite dev server, the Tauri side stood in for by tests/browser/fake-tauri.ts.
//
//   bun run test:browser
//
// Not part of `bun test` (it needs a browser and two servers).
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");
const APP = "http://localhost:1420";
const FAKE = "http://127.0.0.1:1430";

let failures = 0;
function check(what, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` (${detail})`}`);
  if (!ok) failures++;
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`${url} never answered`);
}

const q = async (sql) => (await fetch(`${FAKE}/query`, { method: "POST", body: JSON.stringify({ sql }) })).json();

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "my-book-check-"));
  const servers = [
    spawn("bun", ["tests/browser/fake-tauri.ts", join(dir, "book.db")], { cwd: ROOT, stdio: "ignore" }),
    spawn("bun", ["run", "dev"], { cwd: ROOT, stdio: "ignore" }),
  ];
  const browser = await chromium.launch();
  try {
    await waitFor(FAKE + "/query").catch(() => {});
    await waitFor(APP);
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript({ path: join(__dirname, "fake-tauri-init.js") });

    // Spec: PAGE-1, BOOK-7, BOOK-8, BOOK-9, BOOK-10, BOOK-11, BOOK-5
    await page.goto(APP);
    await page.getByRole("button", { name: "New page" }).first().click();
    await page.waitForURL(/\/page\//);
    const url = page.url();
    await page.locator(".page-title").fill("Simple types");
    await page.keyboard.press("Enter");
    await page.locator(".bn-editor").click();
    for (const line of ["# Introduction", "The identity has type $\\alpha \\to \\alpha$ here.", "- an item"]) {
      await page.keyboard.type(line);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.press("Enter");
    await page.keyboard.type("```");
    await page.keyboard.press("Space");
    await page.keyboard.type("def id (a : α) : α := a");
    await page.waitForTimeout(1500);
    const rows = await q("SELECT type, props, content FROM blocks WHERE deleted_at IS NULL AND type != 'page' ORDER BY position");
    check("each block is its own row", rows.map((r) => r.type).join(",") === "heading,paragraph,list,code", rows.map((r) => r.type).join(","));
    check("inline maths is stored as maths", rows[1]?.content.includes('"type":"math"') && !rows[1]?.content.includes("$"), rows[1]?.content);
    check("code blocks default to Lean", JSON.parse(rows[3]?.props ?? "{}").language === "lean");
    const revs = await q("SELECT count(*) n FROM revisions");
    check("every save writes revisions", revs[0].n >= 5, String(revs[0].n));

    await page.reload();
    await page.waitForTimeout(1500);
    check("content survives a reload", (await page.locator(".bn-editor").innerText()).includes("Introduction"));
    check("maths is typeset", (await page.locator(".math-inline .katex").count()) === 1);
    check("Lean is highlighted", (await page.locator(".bn-editor pre span.shiki").count()) > 1);

    // Spec: PAGE-3, LNK-1
    await page.locator(".bn-editor h1").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/page");
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => u.toString() !== url);
    await page.locator(".page-title").fill("Dependent types");
    await page.locator(".bn-editor").click();
    await page.keyboard.type("See @Simple");
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    check("a link shows its page's title", (await page.locator(".page-link").allInnerTexts()).join() === "Simple types");
    await page.goto(url);
    await page.waitForTimeout(1200);
    check("a subpage shows in its parent with its title", (await page.locator(".page-block").innerText()).includes("Dependent types"));

    // Spec: BLK-3
    const parent = (await q("SELECT id FROM blocks WHERE json_extract(props,'$.title') = 'Simple types'"))[0].id;
    await q(`INSERT INTO blocks (id, type, parent_id, position, props, content, created_at, updated_at)
      VALUES ('blk_00000000000000000000000000', 'diagram', '${parent}', 'a9', '{"kind":"venn"}', '[1,2]', '2026-01-01', '2026-01-01')`);
    await page.reload();
    await page.waitForTimeout(1200);
    check("an unknown block type shows a placeholder", (await page.locator(".unknown-block").count()) === 1);
    await page.locator(".bn-editor h1").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" again");
    await page.waitForTimeout(1500);
    const unknown = (await q("SELECT type, props, content, deleted_at FROM blocks WHERE id = 'blk_00000000000000000000000000'"))[0];
    check(
      "an unknown block is left exactly as stored",
      unknown.type === "diagram" && unknown.props === '{"kind":"venn"}' && unknown.content === "[1,2]" && unknown.deleted_at === null,
      JSON.stringify(unknown),
    );

    // Spec: BOOK-6
    await page.goto(url + "/history");
    await page.waitForTimeout(1200);
    const moments = await page.locator(".moments button").count();
    check("history lists the moments the page changed", moments >= 3, String(moments));
    await page.locator(".moments button").last().click();
    await page.waitForTimeout(500);
    check("the earliest moment shows the page before its blocks", (await page.locator(".history-page").innerText()).includes("empty"));

    // Spec: PAGE-4
    await page.getByRole("button", { name: "+ New page" }).click();
    await page.waitForTimeout(600);
    await page.locator(".page-title").fill("Probability");
    await page.waitForTimeout(800);
    const from = await page.locator(".tree-row", { hasText: "Probability" }).boundingBox();
    const to = await page.locator(".tree-row", { hasText: "Simple types" }).first().boundingBox();
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + from.height / 2 - 10, { steps: 3 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const moved = await q(`SELECT parent_id FROM blocks WHERE json_extract(props,'$.title') = 'Probability'`);
    check("dropping a page onto another puts it inside", moved[0]?.parent_id === parent, JSON.stringify(moved));

    check("no errors in the console", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    for (const s of servers) s.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
