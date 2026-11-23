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
  const dir = mkdtempSync(join(tmpdir(), "commonplace-check-"));
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
    page.on("pageerror", (e) => errors.push(process.env.CHECK_SHOTS ? `${e.message}\n${e.stack}` : e.message));
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
    await page.locator(".tree-new").click();
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

    // Spec: BLK-4
    await page.goto(url);
    await page.waitForTimeout(1200);
    await page.locator(".bn-block-content", { hasText: "an item" }).first().hover();
    await page.waitForTimeout(300);
    await page.locator(".bn-side-menu [draggable='true']").first().dragTo(page.locator(".tree-row", { hasText: "Probability" }));
    await page.waitForTimeout(1200);
    const item = await q(`SELECT json_extract(pg.props,'$.title') AS page FROM blocks b JOIN blocks pg ON pg.id = b.parent_id WHERE b.content LIKE '%an item%'`);
    check("a block dragged onto a page in the sidebar moves there", item[0]?.page === "Probability", JSON.stringify(item));
    check("and leaves the page it came from", !(await page.locator(".bn-editor").innerText()).includes("an item"));

    // Spec: LIB-2, LIB-4, LIB-6, LIB-10, LIB-12, PPL-1, AI-3
    await q(`INSERT INTO settings (key, value) VALUES ('openrouter_api_key', 'sk-test')`);
    await fetch(`${FAKE}/fake-model`, {
      method: "POST",
      body: JSON.stringify({
        answer: {
          title: "On Computable Numbers, with an Application to the Entscheidungsproblem",
          authors: [{ name: "A. M. Turing", institutions: ["University of Cambridge"] }],
          year: 1936,
          kind: "paper",
        },
      }),
    });
    await page.goto(APP + "/library");
    await page.waitForTimeout(800);
    await page.locator("input[type=file]").setInputFiles(join(__dirname, "fixtures", "on-computable-numbers.pdf"));
    await page.waitForURL(/\/library\/lib_/, { timeout: 10000 });
    await page.waitForTimeout(2500);
    const lib = await q("SELECT i.title, i.authors, i.year, i.kind, i.pages, length(f.data) AS size FROM library_items i JOIN library_files f ON f.item_id = i.id");
    check("an uploaded PDF is in the library with its file", lib.length === 1 && lib[0].size > 1000, JSON.stringify(lib));
    check("the model's title and year are on the item", lib[0]?.title.startsWith("On Computable Numbers, with") && lib[0]?.year === 1936, JSON.stringify(lib[0]));
    const sent = await (await fetch(`${FAKE}/fake-requests`)).json();
    const ask = JSON.stringify(sent[0] ?? {});
    check("the model is asked with the first pages' text and a JSON schema", ask.includes("On Computable Numbers - page 3") && ask.includes("json_schema") && ask.includes("claude-haiku"), ask.slice(0, 200));
    const people1 = await q("SELECT p.name, i.name AS inst FROM authorships s JOIN people p ON p.id = s.person_id LEFT JOIN affiliations a ON a.authorship_id = s.id LEFT JOIN institutions i ON i.id = a.institution_id");
    check("its authors and their institutions are linked records", people1.length === 1 && people1[0].name === "A. M. Turing" && people1[0].inst === "University of Cambridge", JSON.stringify(people1));
    check("reading details is in the usage ledger", (await q("SELECT count(*) AS n FROM ai_usage WHERE feature = 'library_details'"))[0].n === 1);
    check("the PDF is drawn in the viewer", (await page.locator(".pdf-page canvas").count()) >= 1);
    check("the viewer counts its pages", (await page.locator(".pdf-toolbar").innerText()).includes("1 / 3"));
    const first = page.url();

    // Spec: PPL-2, PPL-3, PPL-4
    await fetch(`${FAKE}/fake-model`, {
      method: "POST",
      body: JSON.stringify({
        answer: {
          title: "Computing Machinery and Intelligence",
          authors: [
            { name: "Alan Turing", institutions: ["university of cambridge"] },
            { name: "Alonzo Church", institutions: ["Princeton University"] },
          ],
          year: 1950,
          kind: "paper",
        },
      }),
    });
    await page.goto(APP + "/library");
    await page.waitForTimeout(600);
    await page.locator("input[type=file]").setInputFiles(join(__dirname, "fixtures", "computing-machinery.pdf"));
    await page.waitForURL((u) => /\/library\/lib_/.test(u.toString()) && u.toString() !== first, { timeout: 10000 });
    await page.waitForTimeout(2500);
    const sent2 = JSON.stringify((await (await fetch(`${FAKE}/fake-requests`)).json())[1] ?? {});
    check("a PDF without text is sent as images of its first pages", sent2.includes("image_url") && sent2.includes("data:image/jpeg"), sent2.slice(0, 120));
    const counts = await q("SELECT (SELECT count(*) FROM people) AS people, (SELECT count(*) FROM institutions) AS insts");
    check("a new item's authors and institutions link to existing ones", counts[0].people === 2 && counts[0].insts === 2, JSON.stringify(counts));
    await page.locator(".item-authors a", { hasText: "Turing" }).first().click();
    await page.waitForURL(/\/library\/people\//);
    await page.waitForTimeout(800);
    const personText = await page.locator(".entity-screen").innerText();
    check("a person shows everything they wrote", personText.includes("On Computable Numbers") && personText.includes("Computing Machinery"), personText.slice(0, 200));
    check("and who they wrote with, and where", personText.includes("Alonzo Church") && personText.includes("University of Cambridge"));
    await page.locator(".entity-screen a", { hasText: "University of Cambridge" }).click();
    await page.waitForURL(/\/library\/institutions\//);
    await page.waitForTimeout(800);
    const instText = await page.locator(".entity-screen").innerText();
    check("an institution shows its items and people", instText.includes("Computing Machinery") && instText.includes("Turing") && !instText.includes("Church"), instText.slice(0, 200));

    // Spec: PPL-5
    const second = (await q("SELECT id FROM library_items WHERE title = 'Computing Machinery and Intelligence'"))[0].id;
    await q(`INSERT INTO people (id, name, created_at, updated_at) VALUES ('person_00000000000000000000000000', 'Turing the Second', '2026-01-01', '2026-01-01')`);
    await q(`INSERT INTO authorships (id, item_id, person_id, position, created_at) VALUES ('authorship_00000000000000000000000000', '${second}', 'person_00000000000000000000000000', 9, '2026-01-01')`);
    await page.goto(APP + "/library/people/person_00000000000000000000000000");
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Same person as…" }).click();
    await page.locator(".merge-box input").fill("Turing");
    await page.waitForTimeout(300);
    await page.locator(".name-picker-list button", { hasText: "A. M. Turing" }).click();
    await page.waitForTimeout(800);
    const merged = await q("SELECT merged_into FROM people WHERE id = 'person_00000000000000000000000000'");
    check("two people marked the same become one", merged[0]?.merged_into?.startsWith("person_") && page.url().includes(merged[0].merged_into), JSON.stringify(merged));
    check("the merged person's items show under the one", (await page.locator(".entity-screen").innerText()).includes("Computing Machinery"));

    // Spec: LIB-14, LIB-15, LIB-16
    await fetch(`${FAKE}/fake-model`, {
      method: "POST",
      body: JSON.stringify({ answer: { title: "On Computable Numbers, with Contents", authors: [{ name: "Alan Turing", institutions: [] }], year: 1936, kind: "paper" } }),
    });
    await page.goto(APP + "/library");
    await page.waitForTimeout(600);
    await page.locator("input[type=file]").setInputFiles(join(__dirname, "fixtures", "with-contents.pdf"));
    await page.waitForURL((u) => /\/library\/lib_/.test(u.toString()), { timeout: 10000 });
    await page.waitForTimeout(2500);
    const tocItem = (await q("SELECT id, toc FROM library_items WHERE filename = 'with-contents.pdf'"))[0];
    const stored = JSON.parse(tocItem?.toc ?? "[]");
    check(
      "the PDF's outline is kept as its contents, with pages",
      stored.length === 3 && stored[0].children.length === 2 && stored[1].page === 4 && stored[1].children[0].title === "2.1 The halting problem",
      tocItem?.toc,
    );
    if (!(await page.locator(".toc-panel").isVisible())) await page.locator(".toc-toggle").click();
    check("the contents show beside the PDF", (await page.locator(".toc-entry").count()) === 6);
    await page.locator(".toc-entry", { hasText: "Chapter 2: Decidability" }).click();
    await page.waitForTimeout(800);
    check("choosing an entry goes to its page", (await page.locator(".pdf-toolbar").innerText()).includes("4 / 6"));
    check("and marks it as the one being read", (await page.locator(".toc-entry.active").innerText()).includes("Chapter 2"));
    await q(`UPDATE library_items SET toc = NULL WHERE id = '${tocItem.id}'`);
    await page.reload();
    await page.waitForTimeout(2500);
    const again = (await q(`SELECT toc FROM library_items WHERE id = '${tocItem.id}'`))[0]?.toc;
    check("an item without contents gets them when its PDF is opened", JSON.parse(again ?? "[]").length === 3, again);

    // Spec: LIB-20, LIB-21
    check("a PDF opens again at the page last read on this device", (await page.locator(".pdf-toolbar").innerText()).includes("4 / 6"));
    await page.locator(".pdf-page-count").click();
    await page.getByLabel("Go to page").fill("5");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    check("the author can go to a page by its number", (await page.locator(".pdf-toolbar").innerText()).includes("5 / 6"));
    // Spec: LIB-22
    check("the PDF page in view is in the address", page.url().endsWith("#page=5"), page.url());

    // Spec: LIB-18
    const zoomLabel = () => page.locator(".pdf-zoom-fit").textContent();
    const box = await page.locator(".pdf-pages").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await page.waitForTimeout(400);
    check("Ctrl + wheel zooms in", /^\d+% · Fit$/.test(await zoomLabel()) && !(await zoomLabel()).startsWith("100%"), await zoomLabel());
    await page.locator(".pdf-zoom-fit").click();
    await page.waitForTimeout(300);
    check("and the zoom button fits the width again", (await zoomLabel()) === "100%");

    // On a phone
    // Spec: LIB-18, LIB-19
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(600);
    /** Touches on the PDF, as a finger would make them: [[x, y], …] per step, relative to its middle. */
    const touch = (steps) =>
      page.evaluate(async (steps) => {
        const el = document.querySelector(".pdf-pages");
        const r = el.getBoundingClientRect();
        const at = (i, [x, y]) => new Touch({ identifier: i, target: el, clientX: r.left + r.width / 2 + x, clientY: r.top + r.height / 2 + y });
        let before = [];
        for (const [type, points] of steps) {
          const touches = points.map((p, i) => at(i, p));
          const changed = type === "touchend" ? before : touches;
          el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: changed, bubbles: true, cancelable: true }));
          before = touches;
          await new Promise((res) => setTimeout(res, 30));
        }
      }, steps);
    const tapOnce = [["touchstart", [[0, 0]]], ["touchend", []]];
    await touch([...tapOnce, ...tapOnce]);
    await page.waitForTimeout(500);
    check("a double tap zooms in", (await zoomLabel()) === "200% · Fit", await zoomLabel());
    await touch([...tapOnce, ...tapOnce]);
    await page.waitForTimeout(500);
    check("and another fits the width again", (await zoomLabel()) === "100%", await zoomLabel());
    await touch([
      ["touchstart", [[-40, 0], [40, 0]]],
      ["touchmove", [[-60, 0], [60, 0]]],
      ["touchmove", [[-80, 0], [80, 0]]],
      ["touchend", []],
    ]);
    await page.waitForTimeout(500);
    check("two fingers spread zoom in", (await zoomLabel()) === "200% · Fit", await zoomLabel());
    await page.locator(".pdf-zoom-fit").click();
    await page.waitForTimeout(300);
    const reading = () => page.evaluate(() => document.documentElement.classList.contains("pdf-reading"));
    await page.locator(".pdf-pages").evaluate((el) => el.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.locator(".pdf-pages").evaluate((el) => el.scrollBy(0, 300));
    await page.waitForTimeout(300);
    await page.locator(".pdf-pages").evaluate((el) => el.scrollBy(0, 300));
    await page.waitForTimeout(300);
    check("reading down on a phone puts the controls away", (await reading()) && !(await page.locator(".pdf-toolbar").isVisible()));
    check("and a small pill says the page", await page.locator(".pdf-pill").isVisible());
    await page.locator(".pdf-pages").evaluate((el) => el.scrollBy(0, -100));
    await page.waitForTimeout(300);
    check("scrolling back up brings them back", !(await reading()) && (await page.locator(".pdf-toolbar").isVisible()));
    await touch(tapOnce);
    await page.waitForTimeout(600);
    check("a tap puts them away", await reading());
    await touch(tapOnce);
    await page.waitForTimeout(600);
    check("and another brings them back", !(await reading()));
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(300);

    // Spec: LIB-5, LIB-8
    await page.goto(APP + "/library/" + second);
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.locator(".library-details select").selectOption("book");
    await page.waitForTimeout(500);
    check("the author can change an item's details", (await q(`SELECT kind FROM library_items WHERE id = '${second}'`))[0]?.kind === "book");
    // Spec: APP-12
    await page.getByRole("button", { name: "More for this item" }).click();
    await page.getByRole("menuitem", { name: "Remove from the library" }).click();
    await page.getByRole("menuitem", { name: "Really remove it?" }).click();
    await page.waitForURL(/\/library$/);
    const left = await q(`SELECT (SELECT count(*) FROM library_items WHERE id = '${second}') AS items, (SELECT count(*) FROM library_files WHERE item_id = '${second}') AS files, (SELECT count(*) FROM authorships WHERE item_id = '${second}') AS ships`);
    check("removing an item removes its PDF and its authorships", left[0].items === 0 && left[0].files === 0 && left[0].ships === 0, JSON.stringify(left));

    // Spec: CHAT-1, CHAT-3, CHAT-6, CHAT-7, ATL-1
    const chat = (replies) => fetch(`${FAKE}/fake-chat`, { method: "POST", body: JSON.stringify({ replies }) });
    const requests = async () => (await fetch(`${FAKE}/fake-requests`)).json();
    const before = (await requests()).length;
    await chat([{ tools: [{ name: "look_at_screen" }] }, { text: `It defines the identity: ${parent}.` }]);
    await page.goto(url);
    await page.waitForTimeout(1200);
    // Select a word in the editor, then move to the assistant to ask about it.
    await page.locator(".bn-editor p", { hasText: "identity" }).first().click();
    await page.evaluate(() => {
      const p = [...document.querySelectorAll(".bn-editor p")].find((e) => e.textContent?.includes("identity"));
      const walker = p ? document.createTreeWalker(p, NodeFilter.SHOW_TEXT) : null;
      for (let n = walker?.nextNode(); n; n = walker?.nextNode()) {
        const at = n.textContent?.indexOf("identity") ?? -1;
        if (at >= 0) {
          const r = document.createRange();
          r.setStart(n, at);
          r.setEnd(n, at + "identity".length);
          const s = window.getSelection();
          s?.removeAllRanges();
          s?.addRange(r);
          return;
        }
      }
    });
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "Open the assistant" }).click();
    await page.locator(".assistant textarea").fill("What is this page about?");
    await page.locator(".assistant textarea").press("Enter");
    await page.waitForTimeout(2500);
    const asked = (await requests()).slice(before);
    const toolResult = JSON.stringify(asked[1]?.messages ?? []);
    check("the assistant sees the page on screen and the block the cursor is in", toolResult.includes("# Simple types") && toolResult.includes("cursor_block"), JSON.stringify((asked[1]?.messages ?? []).filter((m) => m.role === "tool")).slice(0, 400) + ` | ${asked.length} requests`);
    // Spec: ATL-1, ATL-6, ATL-7
    const look = JSON.parse((asked[1]?.messages ?? []).find((m) => m.role === "tool")?.content ?? "{}");
    check("it gets the address and what the app's addresses mean", look.address?.startsWith("/page/blk_") && look.addresses?.some((r) => r.address === "/page/<page id>"), JSON.stringify(look).slice(0, 200));
    check("it sees what the author selected, kept after moving to the assistant", look.selection?.text === "identity" && look.selection?.in === "editor" && look.selection?.block_ids?.length === 1, JSON.stringify(look.selection));
    const picture = JSON.stringify((asked[1]?.messages ?? []).filter((m) => m.role === "user").slice(-1));
    check("a picture of the screen goes with the turn", picture.includes('"type":"image_url"') && picture.includes("data:image/jpeg"), picture.slice(0, 160));
    check("an id in its answer shows as a chip with the title", (await page.locator(".assistant .entity-chip").allInnerTexts()).join() === "Simple types");
    check("the tools it used are shown with the answer", (await page.locator(".assistant .chat-activity").innerText()).includes("the screen"));
    const chats1 = await q("SELECT id, title, messages FROM chats");
    check("the chat is kept, titled by its first question", chats1.length === 1 && chats1[0].title === "What is this page about?" && JSON.parse(chats1[0].messages).length === 5, JSON.stringify(chats1.map((c) => c.title)));
    check("the picture isn't kept in the chat", !chats1[0].messages.includes("data:image"));

    // Spec: ATL-1, ATL-3
    const libId = (await q("SELECT id FROM library_items LIMIT 1"))[0].id;
    await chat([{ tools: [{ name: "look_at_screen" }, { name: "read_pdf_pages", arguments: { item_id: libId, from_page: 2, to_page: 3 } }] }, { text: "Done." }]);
    await page.goto(APP + "/library/" + libId);
    await page.waitForTimeout(1500);
    // Select text in the PDF's text layer.
    await page.waitForSelector(".textLayer span");
    await page.evaluate(() => {
      const span = [...document.querySelectorAll(".textLayer span")].find((e) => e.textContent?.includes("computable"));
      if (!span?.firstChild) return;
      const r = document.createRange();
      r.selectNodeContents(span);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    });
    await page.waitForTimeout(200);
    await page.locator(".assistant textarea").fill("Explain the page I'm on.");
    await page.locator(".assistant textarea").press("Enter");
    await page.waitForTimeout(2500);
    const libAsk = JSON.stringify((await requests()).slice(-1)[0]?.messages ?? []);
    check("on a library item it sees the PDF page in view, with its text", libAsk.includes("pdf_page_in_view") && libAsk.includes("page 1"), libAsk.slice(-300));
    check("it reads other pages of the PDF", libAsk.includes("page 3") && libAsk.includes("pages_in_pdf"));
    check("it sees text selected in a PDF, and on which page", libAsk.includes('\\"in\\": \\"pdf\\"') && libAsk.includes("pdf_pages"), libAsk.match(/selection[^}]*}/)?.[0] ?? "");

    // Spec: MEM-1, MEM-2, MEM-3, MEM-4
    await chat([{ tools: [{ name: "remember", arguments: { kind: "preference", text: "Be blunt about weak arguments." } }] }, { text: "Noted." }]);
    await page.locator(".assistant textarea").fill("Remember: be blunt about weak arguments.");
    await page.locator(".assistant textarea").press("Enter");
    await page.waitForTimeout(2000);
    check("it keeps what it's asked to remember", (await q("SELECT text FROM assistant_memory"))[0]?.text === "Be blunt about weak arguments.");
    await chat([{ text: "Hello again." }]);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.waitForTimeout(300);
    await page.locator(".assistant textarea").fill("Hi");
    await page.locator(".assistant textarea").press("Enter");
    await page.waitForTimeout(1500);
    check("a new chat starts with the memory", JSON.stringify((await requests()).slice(-1)[0]?.messages ?? []).includes("Be blunt about weak arguments."));
    await page.goto(APP + "/memory");
    await page.waitForTimeout(800);
    check("the memory is shown on its own screen", (await page.locator(".memory-entry textarea").first().inputValue()) === "Be blunt about weak arguments.");

    // Spec: CHAT-2, CHAT-4
    await chat([{ error: "The model is having a bad day" }, { text: "Second time lucky." }]);
    await page.goto(APP + "/chats");
    await page.waitForTimeout(800);
    check("the chats are listed", (await page.locator(".chat-row").count()) === 2);
    await page.locator(".chat-row a", { hasText: "What is this page about?" }).click();
    await page.waitForURL(/\/chats\/chat_/);
    await page.waitForTimeout(800);
    check("a chat has its own address, and shows its thread", (await page.locator(".chat-screen .assistant-turn").count()) >= 6);
    await page.locator(".chat-screen textarea").fill("And one more thing?");
    await page.locator(".chat-screen textarea").press("Enter");
    await page.waitForTimeout(1500);
    const failedText = await page.locator(".chat-screen").innerText();
    if (process.env.CHECK_SHOTS && !failedText.includes("bad day")) await page.screenshot({ path: join(process.env.CHECK_SHOTS, "failed-turn.png") });
    check("a failed turn says so and offers a retry", failedText.includes("bad day"), failedText.slice(-300));
    await page.locator(".chat-screen .assistant-error button", { hasText: "Retry" }).click();
    await page.waitForTimeout(1500);
    check("retrying answers the question", (await page.locator(".chat-screen").innerText()).includes("Second time lucky."));

    // Spec: CHAT-1, APP-12
    await page.goto(APP + "/chats");
    await page.waitForTimeout(600);
    check("the chats list offers no deleting", (await page.locator(".library-list button").count()) === 0);
    await page.locator(".chat-row a").first().click();
    await page.waitForURL(/\/chats\/chat_/);
    await page.getByRole("button", { name: "More for this chat" }).click();
    await page.getByRole("menuitem", { name: "Delete chat" }).click();
    await page.getByRole("menuitem", { name: "Really delete this chat?" }).click();
    await page.waitForURL(/\/chats$/);
    await page.waitForTimeout(600);
    check("a chat can be deleted, and the memory stays", (await q("SELECT count(*) AS n FROM chats"))[0].n === 1 && (await q("SELECT count(*) AS n FROM assistant_memory"))[0].n === 1);

    // Spec: APP-8
    await page.goto(APP + "/settings");
    await page.waitForTimeout(800);
    const settingsRows = await page.locator(".settings-row-title").allInnerTexts();
    check("Settings leads to the pages nested in it", ["AI and models", "Sync", "AI costs"].every((r) => settingsRows.includes(r)), settingsRows.join(", "));
    check("each row says how that part stands", (await page.locator(".settings-row", { hasText: "AI costs" }).innerText()).includes("this month"));
    check("and holds nothing but rows", (await page.locator(".ai-screen .ai-section, .ai-screen input").count()) === 0);
    check("the AI row says the key is set", (await page.locator(".settings-row", { hasText: "AI and models" }).innerText()).includes("Key set"));
    await page.locator(".settings-row", { hasText: "AI and models" }).click();
    await page.waitForURL(/\/settings\/ai$/);
    await page.getByRole("heading", { name: "AI and models" }).waitFor({ timeout: 5000 });
    const aiText = await page.locator(".ai-screen").innerText();
    check("the key and the models are a page of their own", ["OpenRouter", "Assistant model", "Library details model"].every((h) => aiText.includes(h)), aiText.slice(0, 200));
    await page.getByRole("link", { name: "← Settings" }).click();
    await page.waitForURL(/\/settings$/);
    await page.locator(".settings-row", { hasText: "AI costs" }).click();
    await page.waitForURL(/\/settings\/costs$/);
    await page.getByRole("link", { name: "← Settings" }).click();
    await page.waitForURL(/\/settings$/);
    await page.goto(APP + "/sync");
    await page.waitForURL(/\/settings\/sync$/);
    const back = await page.getByRole("link", { name: "← Settings" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check("a nested page leads back, and the old address leads to it", back);

    // Spec: tandem.SYN-9, tandem.SYN-21, tandem.SYN-22
    await page.goto(APP + "/settings/sync");
    await page.getByRole("button", { name: "Show pairing code" }).click();
    const qrImg = page.getByRole("img", { name: "Pairing code" });
    await qrImg.waitFor({ timeout: 5000 });
    await page.addScriptTag({ path: require.resolve("jsqr") });
    const decoded = await qrImg.evaluate(async (img) => {
      await img.decode();
      // As a camera would see it: drawn small, a few pixels per module.
      const c = document.createElement("canvas");
      c.width = c.height = 300;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 300, 300);
      ctx.drawImage(img, 0, 0, 300, 300);
      const data = ctx.getImageData(0, 0, 300, 300);
      return window.jsQR(data.data, 300, 300)?.data ?? null;
    });
    check("the pairing QR code reads back as the code", decoded?.startsWith("mybook-pair:1:") && decoded.length > 300, String(decoded).slice(0, 40));
    // Spec: tandem.SYN-5, tandem.SYN-25
    await page.waitForTimeout(500);
    const announcedWithCode = (await (await fetch(`${FAKE}/fake-lan`)).json()).slice(-1)[0];
    check("the device showing a code announces it nearby, by its tag", announcedWithCode?.pair === "pairfaketag" && announcedWithCode?.book === "bookfaketag" && announcedWithCode?.port === 47832, JSON.stringify(announcedWithCode));
    await page.getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(500);
    check("and stops announcing it once the code is put away", (await (await fetch(`${FAKE}/fake-lan`)).json()).slice(-1)[0]?.pair === "");
    await page.getByRole("button", { name: "Scan code" }).click();
    await page.waitForTimeout(800);
    const camera = (await page.locator(".pairing-camera").isVisible()) || (await page.locator(".mantine-Alert-root", { hasText: "Paste the code instead" }).isVisible());
    check("a computer scans with its webcam, or says to paste", camera);
    if (await page.getByRole("button", { name: "Stop scanning" }).isVisible()) await page.getByRole("button", { name: "Stop scanning" }).click();
    await page.getByLabel("Pairing code").fill(decoded ?? "");
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await page.getByRole("button", { name: "Replace and join" }).waitFor({ timeout: 3000 });
    check("a device holding data asks before it joins", (await page.locator(".mantine-Alert-root").innerText()).includes("holds"));
    await page.getByRole("button", { name: "Replace and join" }).click();
    await page.getByText("Joined The other device's book").waitFor({ timeout: 3000 });
    const joins = await (await fetch(`${FAKE}/fake-joins`)).json();
    check("and then joins, replacing what it held", joins.length === 1 && joins[0].replace === true && joins[0].code === decoded, JSON.stringify(joins).slice(0, 80));

    // Spec: tandem.SYN-23, tandem.SYN-24
    await page.locator(".sync-check").getByRole("button", { name: "Check the connection" }).click();
    await page.locator(".sync-check-verdict").waitFor({ timeout: 5000 });
    const checked = await page.locator(".sync-check").innerText();
    check("checking the connection says what's in the way, and why", checked.includes("macOS is keeping Commonplace off the local network") && checked.includes("No route to host"), checked.slice(0, 300));
    check("and leads to the setting that allows it", await page.locator(".sync-check").getByRole("button", { name: "Open Local Network settings" }).isVisible());

    // Spec: APP-10, APP-11, LIB-22
    await page.goto(`${APP}/library/${tocItem.id}#page=3`);
    await page.waitForTimeout(2500);
    check("an address with a PDF page opens the PDF there", (await page.locator(".pdf-toolbar").innerText()).includes("3 / 6"));
    await page.goto(APP + "/library");
    await page.waitForTimeout(800);
    await page.locator(".library-search").fill("contents");
    await page.locator(".library-filters [role=tab]", { hasText: "Papers" }).click();
    await page.waitForTimeout(400);
    check("the library's search and kind are in the address", /[?&]q=contents/.test(page.url()) && /[?&]kind=paper/.test(page.url()), page.url());
    await page.reload();
    await page.waitForTimeout(1000);
    check("and opening it searches and filters again", (await page.locator(".library-search").inputValue()) === "contents" && (await page.locator(".library-filters [aria-selected=true]").innerText()).startsWith("Paper"));
    await page.locator(".library-list a, .library-item-row a, a[href^='/library/lib_']", { hasText: "With Contents" }).first().click();
    await page.waitForURL(/\/library\/lib_/);
    await page.waitForTimeout(2000);
    await page.locator(".pdf-pages").evaluate((el) => el.scrollBy(0, 2500));
    await page.waitForTimeout(800);
    check("scrolling the PDF keeps the address current", /#page=[2-6]$/.test(page.url()), page.url());
    await page.goBack();
    await page.waitForTimeout(600);
    check("and going back leaves the PDF, not the page before", /\/library\?/.test(page.url()), page.url());

    // Spec: APP-10
    await page.goto(url + "/history");
    await page.waitForTimeout(1200);
    await page.locator(".moments button").last().click();
    await page.waitForTimeout(400);
    check("the moment the history shows is in the address", page.url().includes("?at="), page.url());
    await page.reload();
    await page.waitForTimeout(1200);
    check("and opening it shows that moment", await page.locator(".moments button").last().evaluate((b) => b.classList.contains("active")));
    await page.goto(APP + "/settings/costs");
    await page.getByRole("radio", { name: "Last 90 days" }).click();
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForTimeout(800);
    check("the costs' range is in the address", page.url().endsWith("?range=90d") && (await page.getByRole("radio", { name: "Last 90 days" }).getAttribute("aria-checked")) === "true", page.url());

    // Spec: PAGE-6
    await page.goto(url);
    await page.waitForTimeout(1200);
    await page.locator(".bn-editor p").last().click();
    await page.keyboard.press("End");
    for (let i = 1; i <= 40; i++) {
      await page.keyboard.press("Enter");
      await page.keyboard.type(`Line ${i}`);
    }
    await page.waitForTimeout(1500);
    const topBlock = () =>
      page.evaluate(() => {
        const main = document.querySelector(".main");
        const line = main.getBoundingClientRect().top + 8;
        const hit = [...document.querySelectorAll(".bn-editor .bn-block-outer[data-id]")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top <= line && r.bottom > line;
        });
        return hit.at(-1)?.textContent ?? null;
      });
    await page.locator(".main").evaluate((el) => el.scrollTo(0, 700));
    await page.waitForTimeout(800);
    const topBefore = await topBlock();
    check("a page's address names the block at the top of the view", /#blk_[0-9a-z]+$/.test(page.url()) && topBefore !== null, `${page.url()} ${topBefore}`);
    await page.reload();
    await page.waitForTimeout(1800);
    check("and opening it scrolls that block to the top", (await topBlock()) === topBefore, `${await topBlock()} vs ${topBefore}`);

    // Spec: BLK-5, BLK-6
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(url);
    await page.waitForTimeout(1500);
    if (await page.getByRole("button", { name: "Close the assistant" }).isVisible()) await page.getByRole("button", { name: "Close the assistant" }).click();
    const lineBlock = (n) => page.locator(".bn-editor .bn-block-outer", { hasText: new RegExp(`^Line ${n}$`) });
    const l3 = await lineBlock(3).boundingBox();
    await page.mouse.move(l3.x + 60, l3.y + l3.height / 2);
    await page.waitForTimeout(300);
    const plus = await page.locator(".bn-side-menu button").first().boundingBox();
    const handle = await page.locator('.bn-side-menu [draggable="true"]').boundingBox();
    const text = await page.locator(".bn-editor .bn-inline-content").first().boundingBox();
    check("on a phone the add button sits over the handle", plus && handle && handle.y >= plus.y + plus.height - 2 && Math.abs(handle.x - plus.x) < 6, JSON.stringify({ plus, handle }));
    check("and the text starts close to the screen's edge", text && text.x <= 44, JSON.stringify(text));
    const l1 = await lineBlock(1).boundingBox();
    await page.evaluate(
      async ({ from, to }) => {
        const el = document.querySelector('.bn-side-menu [draggable="true"]');
        const at = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        const fire = (type, t) =>
          el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], targetTouches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
        fire("touchstart", at(from.x, from.y));
        for (let i = 1; i <= 8; i++) {
          fire("touchmove", at(from.x, from.y + ((to.y - from.y) * i) / 8));
          await new Promise((r) => setTimeout(r, 40));
        }
        await new Promise((r) => setTimeout(r, 100));
        fire("touchend", at(from.x, to.y));
      },
      { from: { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, to: { x: 0, y: l1.y + 4 } },
    );
    await page.waitForTimeout(1500);
    const order = (await q(`SELECT content FROM blocks WHERE parent_id = '${parent}' AND deleted_at IS NULL AND content LIKE '%Line %' ORDER BY position`)).map((r) => /Line \d+/.exec(r.content)?.[0]);
    check("a finger drags a block by its handle", order.indexOf("Line 3") >= 0 && order.indexOf("Line 3") < order.indexOf("Line 1"), order.slice(0, 5).join(", "));
    await page.setViewportSize({ width: 1200, height: 800 });

    // Spec: CHAT-8
    await chat([{ text: `It's on [page 4](/library/${tocItem.id}#page=4).` }]);
    if (await page.getByRole("button", { name: "Open the assistant" }).isVisible()) await page.getByRole("button", { name: "Open the assistant" }).click();
    await page.locator(".assistant").getByRole("button", { name: "New", exact: true }).click();
    await page.locator(".assistant textarea").fill("Where is the halting problem?");
    await page.locator(".assistant textarea").press("Enter");
    await page.locator(".assistant a", { hasText: "page 4" }).click({ timeout: 5000 });
    await page.waitForURL(/\/library\/lib_.*#page=4$/);
    await page.waitForTimeout(2500);
    check("an address in an answer opens in the app, at the page", (await page.locator(".pdf-toolbar").innerText()).includes("4 / 6"));

    // Spec: LEAN-1, LEAN-2, LEAN-3, LEAN-4, LEAN-5, LEAN-9
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(url);
    await page.waitForTimeout(1200);
    await page.locator(".tree-new").click();
    await page.waitForTimeout(600);
    await page.locator(".page-title").fill("Proofs");
    await page.waitForTimeout(600);
    await page.locator(".bn-editor").click();
    await page.keyboard.type("/lean");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    check("/lean makes a Lean block, ready to type in", (await page.locator(".lean-block").count()) === 1 && (await page.evaluate(() => document.activeElement?.classList.contains("lean-input"))));
    await page.keyboard.type("theorem t (n : \\N) : n + 0 = n := by\n  sorry");
    const leanSource = () => page.locator(".lean-input").inputValue();
    check("a backslash abbreviation turns into its symbol", (await leanSource()).startsWith("theorem t (n : ℕ) :"), await leanSource());
    await page.getByLabel("Module name").fill("Peano");
    await page.waitForTimeout(2500);
    check("a computer verifies it, and says it holds by sorry", (await page.locator(".lean-status").innerText()).includes("Verified with sorry"), await page.locator(".lean-status").innerText());
    check("the sorry is underlined, and Lean's message shown", (await page.locator(".lean-mark.warning").count()) >= 1 && (await page.locator(".lean-message").innerText()).includes("sorry"));
    const leanRow = async (id) => (await q(`SELECT c.status, c.source_hash, c.deps FROM lean_checks c JOIN blocks b ON b.id = c.block_id WHERE json_extract(b.props, '$.name') = '${id}'`))[0];
    const peanoRow = await leanRow("Peano");
    const expectHash = require("node:crypto").createHash("sha256").update(`Peano\n${await leanSource()}`).digest("hex");
    check("the verdict is kept with the source it holds for", peanoRow?.status === "sorry" && peanoRow?.source_hash === expectHash, JSON.stringify(peanoRow));
    await page.locator(".lean-input").fill("theorem t (n : ℕ) : n + 0 = n := by\n  simp");
    await page.waitForTimeout(2500);
    check("changed and checked again, it's verified", (await page.locator(".lean-status").innerText()).includes("Verified") && !(await page.locator(".lean-status").innerText()).includes("sorry"));
    await page.locator(".lean-input").click();
    await page.keyboard.press("End");
    await page.waitForTimeout(800);
    check("the proof state at the cursor shows with the block", (await page.locator(".lean-goals").innerText()).includes("⊢ n + 0 = n"));
    // A block importing it: what it imports is part of its verdict.
    await page.locator(".bn-editor .bn-block-outer").last().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.locator(".bn-editor").click({ position: { x: 60, y: 2 } });
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/lean");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await page.keyboard.type("import Book.Peano\n#eval 1 + 1");
    await page.locator(".lean-block").last().getByLabel("Module name").fill("UsesPeano");
    await page.waitForTimeout(2500);
    const uses = await leanRow("UsesPeano");
    const peanoHash = (await leanRow("Peano"))?.source_hash;
    check("a block's verdict holds for the blocks it imports as they were", JSON.parse(uses?.deps ?? "[]")[0]?.hash === peanoHash && uses?.status === "verified", JSON.stringify(uses));
    check("and what #eval printed shows under it", (await page.locator(".lean-block").last().locator(".lean-message.information").innerText()).includes("2"));
    const md = (await q(`SELECT type FROM blocks WHERE type = 'lean' AND deleted_at IS NULL`)).length;
    check("Lean blocks are stored as blocks of their own", md === 2, String(md));
    await page.goto(APP + "/settings");
    await page.waitForTimeout(800);
    check("Settings says whether this computer verifies Lean", (await page.locator(".settings-row", { hasText: "Lean" }).innerText()).includes("Ready · Lean v4.99.0"));
    await page.locator(".settings-row", { hasText: "Lean" }).click();
    await page.getByRole("heading", { name: "Lean" }).waitFor({ timeout: 5000 });
    check("and Settings → Lean says how it stands", (await page.locator(".ai-screen").innerText()).includes("Ready: Lean v4.99.0, with Mathlib."));

    // Spec: LIB-23, LIB-24, LIB-27
    await page.setViewportSize({ width: 1200, height: 800 });
    await fetch(`${FAKE}/fake-model`, {
      method: "POST",
      body: JSON.stringify({
        answer: {
          title: "Something else",
          authors: [
            { name: "A. Vaswani", institutions: ["Google Brain"] },
            { name: "N. Shazeer", institutions: ["Google Brain"] },
            { name: "N. Parmar", institutions: ["Google Research"] },
            { name: "J. Uszkoreit", institutions: ["Google Research"] },
            { name: "L. Jones", institutions: ["Google Research"] },
          ],
          year: 1999,
          kind: "book",
        },
      }),
    });
    await page.goto(APP + "/library");
    await page.waitForTimeout(800);
    await page.getByLabel("arXiv number or address").fill("arXiv:1706.03762v5");
    await page.getByRole("button", { name: "Add from arXiv" }).click();
    await page.waitForURL(/\/library\/lib_/, { timeout: 15000 });
    await page.waitForTimeout(2500);
    const arx = (await q("SELECT i.id, i.title, i.year, i.kind, i.arxiv_id, length(f.data) AS pdf, h.html FROM library_items i LEFT JOIN library_files f ON f.item_id = i.id LEFT JOIN library_html h ON h.item_id = i.id WHERE i.arxiv_id IS NOT NULL"))[0];
    check("a paper comes from arXiv by its number, with arXiv's title and year", arx?.title === "Attention Is All You Need" && arx?.year === 2017 && arx?.kind === "paper" && arx?.arxiv_id === "1706.03762", JSON.stringify({ ...arx, html: undefined }));
    check("with its PDF and its HTML version", arx?.pdf > 1000 && typeof arx?.html === "string" && arx.html.includes("ltx_section"));
    check("the HTML keeps its figures inside it, named from the page's address as a browser reads them", arx?.html.includes('src="data:image/png;base64,') && arx?.html.includes('src="data:image/svg+xml;base64,'));
    check("without LaTeX's leftovers: unknown commands, the logos before the title, author notes", !arx?.html.includes("affillogo") && !arx?.html.includes("ltx_ERROR") && !arx?.html.includes("Affiliation: [") && !arx?.html.includes("brain.svg"));
    check("and carries nothing that runs", !arx?.html.includes("<script") && !arx?.html.includes("onclick") && !arx?.html.includes("ltx_page_navbar"));
    const arxAuthors = await q(`SELECT p.name, i.name AS inst FROM authorships s JOIN people p ON p.id = s.person_id LEFT JOIN affiliations a ON a.authorship_id = s.id LEFT JOIN institutions i ON i.id = a.institution_id WHERE s.item_id = '${arx?.id}' ORDER BY s.position`);
    check("arXiv's authors stand, with the institutions the model read", arxAuthors.map((a) => `${a.name}/${a.inst}`).join(", ") === "Ashish Vaswani/Google Brain, Noam Shazeer/Google Brain, Niki Parmar/Google Research, Jakob Uszkoreit/Google Research, Llion Jones/Google Research", JSON.stringify(arxAuthors));

    // Spec: LIB-25, LIB-26
    check("on a computer it opens as its PDF, with a way to read it as text", (await page.locator(".pdf-page canvas").count()) >= 1 && (await page.getByRole("tab", { name: "Text" }).count()) === 1);
    await page.getByRole("tab", { name: "Text" }).click();
    await page.waitForTimeout(1200);
    check("read as text, the address says so", /[?&]view=text/.test(page.url()), page.url());
    const reader = page.locator(".html-reader");
    check("the text shows, its maths as maths and its figure", (await reader.innerText()).includes("1 Introduction") && (await reader.locator("math").count()) >= 2 && (await reader.locator('img[src^="data:"]').count()) === 2);
    check("and LaTeX's source doesn't show as text", !(await reader.innerText()).includes("h_{t}"));
    if (!(await page.locator(".toc-panel").isVisible())) await page.locator(".toc-toggle").click();
    const tocText = await page.locator(".toc").innerText();
    check("its sections are its contents", ["1 Introduction", "2 Model", "2.1 Attention", "References"].every((s) => tocText.includes(s)), tocText);
    await page.locator(".toc-entry", { hasText: "2.1 Attention" }).click();
    await page.waitForTimeout(900);
    check("choosing a section goes there, and the address holds it", page.url().endsWith("#S2.SS1") && (await page.locator(".toc-entry.active").innerText()).includes("2.1"), page.url());
    await page.reload();
    await page.waitForTimeout(1800);
    const at = await page.evaluate(() => {
      const s = document.querySelector(".html-pages");
      const el = document.getElementById("S2.SS1");
      return s && el ? Math.round(el.getBoundingClientRect().top - s.getBoundingClientRect().top) : null;
    });
    check("and opening the address opens the text at that section", at !== null && Math.abs(at) < 30, String(at));

    // Spec: ATL-10
    const before2 = (await (await fetch(`${FAKE}/fake-requests`)).json()).length;
    await chat([{ tools: [{ name: "look_at_screen" }, { name: "read_section", arguments: { item_id: arx?.id, section_id: "S2.SS1" } }] }, { text: "It's about attention." }]);
    if (await page.getByRole("button", { name: "Open the assistant" }).isVisible()) await page.getByRole("button", { name: "Open the assistant" }).click();
    await page.locator(".assistant").getByRole("button", { name: "New", exact: true }).click();
    await page.locator(".assistant textarea").fill("What is this section about?");
    await page.locator(".assistant textarea").press("Enter");
    await page.waitForTimeout(2500);
    const toolMsgs = JSON.stringify(((await (await fetch(`${FAKE}/fake-requests`)).json()).slice(before2)[1]?.messages ?? []).filter((m) => m.role === "tool"));
    check("the assistant sees the section in view, and reads a section with its maths as LaTeX", toolMsgs.includes("section_in_view") && toolMsgs.includes("S2.SS1") && toolMsgs.includes("softmax}(QK^{T})V"), toolMsgs.slice(0, 300));
    await page.getByRole("button", { name: "Close the assistant" }).click();

    // Spec: LIB-23
    await page.goto(APP + "/library");
    await page.waitForTimeout(600);
    await page.getByLabel("arXiv number or address").fill("https://arxiv.org/abs/1706.03762");
    await page.getByRole("button", { name: "Add from arXiv" }).click();
    await page.waitForURL(/\/library\/lib_/, { timeout: 15000 });
    check("adding it again opens the one already there", page.url().includes(arx?.id) && (await q("SELECT count(*) AS n FROM library_items WHERE arxiv_id = '1706.03762'"))[0].n === 1);
    await page.goto(APP + "/library");
    await page.waitForTimeout(600);
    await page.getByLabel("arXiv number or address").fill("2101.99999");
    await page.getByRole("button", { name: "Add from arXiv" }).click();
    await page.waitForTimeout(1500);
    check("an unknown number says so", (await page.locator(".library-problem").innerText()).includes("arXiv doesn't know 2101.99999"));

    // Spec: LIB-25
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${APP}/library/${arx?.id}`);
    await page.waitForTimeout(1500);
    check("on a phone it opens as text", await page.locator(".html-reader").isVisible());
    if (process.env.CHECK_SHOTS) await page.screenshot({ path: join(process.env.CHECK_SHOTS, "phone-text.png") });
    // Spec: LIB-25
    const titleWidth = (await page.locator(".library-item-title").boundingBox())?.width ?? 0;
    check("with room for its title in the bar", titleWidth > 150, String(titleWidth));
    const figure = await page.locator('.html-reader img[alt="The Transformer"]').boundingBox();
    check("and its figures fit the screen", figure !== null && figure.width <= 390 && figure.height < 600, JSON.stringify(figure));
    // Spec: PPL-8
    const authorsLine = page.locator(".item-head .item-authors");
    check(
      "its authors are a line of names, the rest of a long list on asking",
      (await authorsLine.locator("a").count()) === 3 && (await authorsLine.innerText()).includes("and 2 more") && !(await authorsLine.innerText()).includes("Google"),
      await authorsLine.innerText(),
    );
    await authorsLine.getByRole("button", { name: "and 2 more" }).click();
    check("and all of them, with their institutions, when asked", (await authorsLine.innerText()).includes("Llion Jones") && (await authorsLine.innerText()).includes("Google Research"), await authorsLine.innerText());
    await authorsLine.getByRole("button", { name: "Less" }).click();
    await authorsLine.locator("a").first().click();
    await page.waitForURL(/\/library\/people\/person_/, { timeout: 5000 });
    check("each name leads to what else the library has of theirs", (await page.locator(".screen").innerText()).includes("Attention Is All You Need"));
    // Spec: LIB-19
    await page.goto(`${APP}/library/${arx?.id}`);
    await page.waitForTimeout(1500);
    const scrollText = async (by) => {
      await page.locator(".html-pages").evaluate((s, d) => s.scrollBy(0, d), by);
      await page.waitForTimeout(400);
    };
    await scrollText(300);
    await scrollText(300);
    if (process.env.CHECK_SHOTS) await page.screenshot({ path: join(process.env.CHECK_SHOTS, "phone-text-reading.png") });
    check("reading down as text, what's around it steps aside", (await page.evaluate(() => document.documentElement.classList.contains("pdf-reading"))) && !(await page.locator(".library-item-bar").isVisible()) && !(await page.locator(".item-head").isVisible()));
    await scrollText(-200);
    check("and comes back on scrolling up", !(await page.evaluate(() => document.documentElement.classList.contains("pdf-reading"))) && (await page.locator(".library-item-bar").isVisible()));
    await page.setViewportSize({ width: 1200, height: 800 });

    // Spec: AUD-2, AUD-3, AUD-5, AUD-6, AUD-7
    await page.setViewportSize({ width: 1200, height: 800 });
    await fetch(`${FAKE}/fake-model`, {
      method: "POST",
      body: JSON.stringify({ answer: { paragraphs: ["Two point one. Attention.", "Scaled dot-product attention: softmax of Q K transpose, times V."] } }),
    });
    const sentBefore = (await (await fetch(`${FAKE}/fake-requests`)).json()).length;
    await page.goto(`${APP}/library/${arx?.id}`);
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "More for this item" }).click();
    await page.getByRole("menuitem", { name: "Record aloud…" }).click();
    await page.getByLabel("What to read").selectOption({ label: "\u20032.1 Attention" });
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.waitForURL(/\/audio\/recording_/, { timeout: 10000 });
    await page.waitForTimeout(2500);
    const rec = (await q("SELECT id, kind, section, status, script, chapters, duration_seconds, voice, speech_model FROM recordings"))[0];
    check("a section of a paper is recorded aloud, word for word", rec?.kind === "verbatim" && rec?.section === "html:S2.SS1" && rec?.status === "ready", JSON.stringify({ ...rec, script: undefined }));
    check("its script is what the script model made of the section", JSON.parse(rec?.script ?? "{}").chapters?.[0]?.paragraphs?.[1]?.startsWith("Scaled dot-product attention: softmax of Q K"), rec?.script);
    const scriptAsk = JSON.stringify((await (await fetch(`${FAKE}/fake-requests`)).json()).slice(sentBefore));
    check("the script model is told to keep the prose and say the maths", scriptAsk.includes("Keep every word of the prose exactly") && scriptAsk.includes("2.1 Attention") && scriptAsk.includes("softmax}(QK^{T})V"), scriptAsk.slice(0, 200));
    check("in the voice and speech model chosen", rec?.voice === "Charon" && rec?.speech_model === "google/gemini-3.1-flash-tts-preview");
    check("its audio is Opus in WebM, kept to sync", (await q(`SELECT media_type, length(data) AS n FROM recording_files WHERE recording_id = '${rec?.id}'`))[0]?.media_type === "audio/webm");

    // Spec: AUD-8, AUD-9, AUD-12
    await page.getByRole("button", { name: "Play" }).click();
    await page.waitForTimeout(1600);
    check("the player plays it", (await page.getByRole("button", { name: "Pause" }).count()) === 1 && /#t=[1-3]$/.test(page.url()), page.url());
    await page.getByRole("radio", { name: "1.5×" }).click();
    check("at a speed chosen", (await page.getByRole("radio", { name: "1.5×" }).getAttribute("aria-checked")) === "true");
    await page.getByRole("button", { name: "Pause" }).click();
    await page.waitForTimeout(600);
    const listened = await q(`SELECT position FROM listening WHERE recording_id = '${rec?.id}'`);
    check("where it was left is kept", listened[0]?.position > 0.5, JSON.stringify(listened));
    await page.locator(".recording-chapters button").first().click();
    await page.waitForTimeout(300);
    check("a chapter goes to its start", (await page.locator(".player-times span").first().innerText()) === "0:00");
    await page.goto(`${APP}/audio/${rec?.id}#t=2`);
    await page.waitForTimeout(1800);
    check("an address with a moment opens the recording there", (await page.locator(".player-times span").first().innerText()) === "0:02", await page.locator(".player-times span").first().innerText());

    // Spec: AUD-1, APP-12
    await page.getByRole("link", { name: "← Audio" }).click();
    await page.waitForURL(/\/audio$/);
    await page.waitForTimeout(800);
    check("the audio library lists it, and offers no deleting", (await page.locator(".library-list").innerText()).includes("2.1 Attention") && (await page.locator(".library-list button").count()) === 0);
    check("what's playing stays at hand on other screens", await page.locator(".mini-player").isVisible());

    // Spec: AUD-4
    await fetch(`${FAKE}/fake-model`, {
      method: "POST",
      body: JSON.stringify({ answer: { title: "Two papers on machines", parts: [{ title: "The question", paragraphs: ["What can machines compute?"] }, { title: "The answer", paragraphs: ["Less than everything."] }] } }),
    });
    await page.getByRole("button", { name: "Summarize papers…" }).click();
    await page.locator(".summarize-items label").nth(0).click();
    await page.locator(".summarize-items label").nth(1).click();
    await page.getByRole("radio", { name: "5 min", exact: true }).click();
    await page.getByRole("button", { name: "Record summary" }).click();
    await page.waitForURL(/\/audio\/recording_/, { timeout: 10000 });
    await page.waitForTimeout(2000);
    const sum = (await q("SELECT title, kind, minutes, items, chapters FROM recordings WHERE kind = 'summary'"))[0];
    check("several papers are summarized aloud, one narrator, at the length chosen", sum?.title === "Two papers on machines" && sum?.minutes === 5 && JSON.parse(sum?.items ?? "[]").length === 2, JSON.stringify(sum));
    check("the summary's parts are its chapters", (await page.locator(".recording-chapters").innerText()).includes("The question") && JSON.parse(sum?.chapters ?? "[]").length === 2);
    const sumAsk = JSON.stringify((await (await fetch(`${FAKE}/fake-requests`)).json()).slice(-1));
    check("asked for the words five minutes take", sumAsk.includes("About 750 words"));
    // Spec: AUD-4
    const writers = (await q(`SELECT p.name FROM authorships s JOIN people p ON p.id = s.person_id WHERE s.item_id IN (${JSON.parse(sum?.items ?? "[]").map((i) => `'${i}'`).join(",")})`)).map((r) => r.name);
    check("and told nothing of who wrote them", writers.length > 0 && writers.every((n) => !sumAsk.includes(n)), JSON.stringify(writers));

    // Spec: APP-12
    await page.getByRole("button", { name: "More for this recording" }).click();
    await page.getByRole("menuitem", { name: "Delete recording" }).click();
    await page.getByRole("menuitem", { name: "Really delete this recording?" }).click();
    await page.waitForURL(/\/audio$/);
    check("a recording is deleted from its own menu", (await q("SELECT count(*) AS n FROM recordings WHERE kind = 'summary'"))[0].n === 0);

    // Spec: WORK-1
    const work = await (await fetch(`${FAKE}/fake-work`)).json();
    check(
      "an answer, a recording's script and an item's details run as work, each begun and ended",
      ["Answering “", "Writing the script for “", "Reading the details of “", "from arXiv"].every(
        (w) => work.log.some((e) => e.event === "begin" && e.title.includes(w)) && work.log.some((e) => e.event === "end" && e.title.includes(w)),
      ),
      JSON.stringify(work.log.slice(-6)),
    );
    check("and nothing is left running once it's all done", work.running.length === 0, JSON.stringify(work.running));

    // Spec: DIAG-1, DIAG-2, DIAG-3
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.evaluate(() => setTimeout(() => {
      throw new Error("A failure nothing caught, from the checks");
    }));
    await page.waitForTimeout(800);
    for (let i = errors.length - 1; i >= 0; i--) if (errors[i].includes("from the checks")) errors.splice(i, 1);
    await page.goto(APP + "/settings");
    await page.waitForTimeout(1000);
    const diagRow = await page.locator(".settings-row", { hasText: "Diagnostics" }).innerText();
    check("Settings has a Diagnostics row saying what failed in the last day", /\d+ failures? in the last day/.test(diagRow), diagRow);
    await page.locator(".settings-row", { hasText: "Diagnostics" }).click();
    await page.waitForURL(/\/settings\/diagnostics$/);
    await page.waitForTimeout(1000);
    const log = await page.locator(".diag-log").innerText();
    check("the log has the failed answer with what the model said", log.includes("Failed: Answering") && log.includes("bad day"), log.slice(0, 400));
    check("and what nothing caught", log.includes("A failure nothing caught, from the checks"));
    check("and the work done, and the screens opened", log.includes("Finished: Writing the script for") && log.includes("Opened /library"));
    await page.getByRole("radio", { name: "Failures" }).click();
    await page.waitForTimeout(600);
    const failuresOnly = await page.locator(".diag-log").innerText();
    check("failures alone, when chosen, with the address saying so", page.url().endsWith("?show=failures") && failuresOnly.includes("Failed: Answering") && !failuresOnly.includes("Opened /"), page.url());
    check(
      "the log is plain text, an entry a line with its details under it, as copied",
      /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d  ERROR {4}assistant  Failed: Answering[^\n]*\n {4}on \/chats\/chat_/.test(failuresOnly),
      failuresOnly.slice(0, 300),
    );
    if (process.env.CHECK_SHOTS) {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(APP + "/settings/diagnostics");
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(process.env.CHECK_SHOTS, "diagnostics-phone.png") });
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto(APP + "/settings/diagnostics?show=failures");
      await page.waitForTimeout(1000);
    }

    // Spec: DIAG-4, DIAG-5
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
    await page.getByRole("button", { name: "Copy everything" }).click();
    await page.waitForTimeout(1500);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(
      "one press copies everything for a coding agent: the app, how it's set up, and the log oldest first",
      copied.startsWith("# Commonplace diagnostics") &&
        copied.includes("- Version: 0.1.0 (development build, com.madsbuch.commonplace.dev") &&
        copied.includes("- Models: assistant ") &&
        copied.includes("## Running now") &&
        copied.indexOf("Opened /") < copied.indexOf("Failed: Answering") &&
        /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d  ERROR {4}assistant  Failed: Answering/.test(copied),
      copied.slice(0, 600),
    );
    check("and never the key", !copied.includes("sk-test") && copied.includes("an OpenRouter key is set"));
    check("the page says it's copied", (await page.locator(".diag-actions [role=status]").innerText()).startsWith("Copied, with "));

    // Spec: DIAG-6
    await page.getByRole("button", { name: "More for the diagnostics" }).click();
    await page.getByRole("menuitem", { name: "Empty the log" }).click();
    await page.getByRole("menuitem", { name: "Really empty it?" }).click();
    await page.waitForTimeout(800);
    check("the log is emptied from its menu, asking first", (await q("SELECT count(*) AS n FROM diagnostics WHERE level = 'error'"))[0].n === 0);

    check("no errors in the console", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    for (const s of servers) s.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
