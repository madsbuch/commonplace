# Commonplace

An ever-evolving personal book: a Tauri 2 app (React + TypeScript frontend in
`src/`, Rust shell in `src-tauri/`) on Android, Linux and macOS, backed by one
SQLite database per device that syncs peer-to-peer over the local network.
The build system and code rules follow https://github.com/madsbuch/tally.

## The spec

What the product is meant to do is written in `.spec/`, in the format of
https://github.com/madsbuch/better-github/blob/main/spec-llms.txt (read it
before editing the spec).

- The spec comes first: a change to what the product does starts as a new
  requirement, a new `version` of one (old text into `history`, with the
  `reason`), or a deprecation with its reason. Nothing is deleted,
  renumbered or reused; history is never edited.
- Before adding a requirement, look among the deprecated ones for the same
  idea; don't bring one back without asking.
- What isn't decided stays out of the spec. Ask instead of guessing.
- Requirement id prefixes: `BOOK-` (book), `PAGE-` (pages), `BLK-` (blocks),
  `PAR-`/`HEAD-`/`LIST-`/`CODE-`/`LEAN-` (block types), `LNK-` (links), `LIB-` (library), `AUD-` (the audio library), `PPL-` (people and institutions), `AST-`
  (assistant), `CHAT-` (chats), `ATL-` (assistant tools), `MEM-` (memory), `AI-` (models and costs), `APP-` (app), `STO-` (storage),
  `SYN-` (what syncing a book adds), `ENG-` (engineering), `DEV-` (development builds), `ID-` (row ids), `DIAG-` (diagnostics), `WORK-` (work in
  the background). Stories use `US-`. Requirements keep their
  id when moved, so older prefixes (e.g. `BOOK-5` under revisions) appear
  outside their home item.
- A new block type is a new item in `.spec/book/blocks/` with its own prefix.
- The spec never names code; code names the spec. Code or a test that exists
  to meet a requirement carries `// Spec: BOOK-1` (ids only) on its own line.
  When a requirement changes, search for its id. Code cites only
  requirements that hold: not deprecated ones, not waived ones.
- Constants in the code follow the spec's named values; change both together.
- Sync is the shared part Tandem (`.spec/tandem`, ids `tandem.SYN-`,
  `tandem.TRG-`, values `tandem.*`), copied from madsbuch/spec-repo and
  recorded in `imports` in `.spec/index.json`; its collection is the book.
  Never edit the copy: change the part in madsbuch/spec-repo and import it
  again, then reconcile. What the book does differently goes in the import
  (`values`, `waived`, each with its reason), and the product's own entries
  link to the part's with `related`. The product's own `SYN-` and `TRG-`
  requirements that Tandem took over are deprecated in its favour; `SYN-14`
  and `SYN-20` (revisions, chats) are the book's own.
- The engineering rules are the shared part Keel (`.spec/keel`, ids
  `keel.ENG-`, `keel.TYP-`, `keel.JSN-`, value `keel.deps-minimum-age`),
  imported the same way: the stack, the build, the package age, type safety
  and the JSON boundary (the two sections below). The product's own `ENG-1`,
  `ENG-2` and `ENG-6` are deprecated in its favour; the rest of `ENG-` is the
  product's own.
- `tests/shared-values.test.ts` holds constants to the shared parts' values
  as the app sets them (an override in the import's `values` wins): sync's
  `PAIRING_TTL`, snapshots' `DAILY` and `WEEKLY_UNTIL`, and bunfig's
  `minimumReleaseAge`.
- `tests/spec.test.ts` (part of `bun test`) checks the spec: schema, unique
  ids, references, histories, that every imported part is unchanged (git's
  tree id of its folder, as `tree` records), and that every `Spec:` citation
  names a requirement that holds.

## JSON boundary rule

(`keel.JSN-*`)

All untrusted JSON (SQLite JSON columns, model output, OpenRouter responses,
settings blobs) is parsed through a zod schema in `src/lib/schemas.ts`.

- `JSON.parse` is only allowed inside `src/lib/schemas.ts` (its `parseJson`
  helper). ESLint enforces this.
- Never cast parsed JSON with `as`: add a schema and a typed parse helper.
- The same goes for what Tauri commands and plugins hand back: no
  `invoke<T>()` and no `as` on an awaited result (ESLint enforces both).
- Prefer `z.infer` over parallel interfaces. Schemas for model/API output are
  forgiving (coerce and default); schemas for our own persisted data are
  strict, so corruption surfaces.

## No casts, no `!`, no `any`, no unsafe

(`keel.TYP-*`)

ESLint holds all TypeScript (`src/`, `tests/`, `scripts/`) to these, and an
`eslint-disable` comment can't switch them off (only
`react-hooks/exhaustive-deps` may be disabled inline). `tsc` typechecks only
`src/`.

- No type assertions (`x as T`; `as const` is fine) and no non-null `!`.
  Narrow instead, or parse with a schema.
- No `any`, and in `src/` no `any` flowing anywhere (`no-unsafe-*`).
- No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`.
- No native `confirm`/`alert`/`prompt`: the desktop WebView doesn't show them.
- Rust: every crate under `src-tauri` and `tools` sets `unsafe_code =
  "forbid"` in its `Cargo.toml`, except the app crate (`src-tauri`), which
  sets `"deny"` for one audited exception: the JNI entry point in
  `src/sync/background.rs` needs `#[no_mangle]` and carries
  `#[allow(unsafe_code)]`. That code is Android-only, so a desktop `cargo
  check` never sees it: only the APK build (CI) does.

## Sync

The book syncs peer to peer over the local network, as Tally does
(`src-tauri/src/sync/`, ported from it; see its module docs).

- Every table syncs between the book's devices unless it's listed in
  `LOCAL_TABLES` (`scripts/sync-triggers.ts`: `device_settings`, sync's
  own bookkeeping, `speech_clips` (passages spoken by recordings made before) and `diagnostics`). Sync rides on triggers: a migration that adds a table
  must add its triggers (`bun scripts/sync-triggers.ts <table>` prints them,
  appended after a `-- @generated` line); one that rebuilds a table must
  re-create them (dropping a table drops its triggers); and one that adds a
  column must re-create that table's triggers (`--retrigger <table>`), since
  the update trigger lists the columns it watches.
  `tests/sync-tracking.test.ts` fails for any of these left undone.
- Trigger SQL must run on Android 14's SQLite 3.39; CI checks with
  `tools/sqlite-android-compat`
  (`cargo run --manifest-path tools/sqlite-android-compat/Cargo.toml -- .`).
- Concurrent changes to a row resolve to the later clock, whole row. That's
  why a block is a row of its own and every save also inserts a `revisions`
  row: two devices editing the same block keep both edits as revisions.
- Chats are the one exception (`chats` in `src-tauri/src/sync/engine.rs`):
  a chat continued on two devices at once is split, the losing side kept as
  a new chat titled "<title> (continued in parallel)". Its id is a `chat_`
  TypeID derived from the losing version (`src-tauri/src/type_id.rs`, which
  must agree with `src/lib/ids.ts`), so every device makes the same one.
- No foreign keys between synced tables: rows arrive one at a time in any
  order. (Sync does handle cascades and unique columns, should a table need
  them; the Rust tests cover both with tables of their own.)
- Settings that belong to one device are listed in `DEVICE_SETTING_KEYS`
  (`src/lib/settings.ts`) and live in `device_settings`.
- Development and release builds never sync with each other (`same_build`
  in `src-tauri/src/sync/session.rs`).
- Devices find each other as Murmur does (tandem.SYN-5; github.com/madsbuch/murmur):
  `src-tauri/plugins/lan` is Murmur's LAN plugin, ported (Android's
  NsdManager in `LanPlugin.kt`, with a multicast lock, stopped while the app
  is paused; `mdns-sd` on computers). Each device announces
  `_commonplace._tcp` with its sync port and, in TXT, the book's tag, its
  device id and, while it shows a pairing code, the code's tag
  (`session::pair_tag`, tandem.SYN-25); `src/lib/lan.ts` asks Rust what to announce
  (`sync_announce`), announces again when that changes (a code shown or put
  away, a join, sync status, coming back in sight) and passes every device
  found, with all its addresses (IPv6 too, link-local with its scope), to
  Rust (`sync_peer_found`, kept in `SyncService::nearby`). A sync round tries
  a book device at every address it announced, where the UDP search found
  it and where it was last reached, all at once (`check::connect_any`, the
  first to answer wins); a join waits up to 3 s for the device announcing
  the code's tag and tries its addresses with the code's. Sync listens on one
  dual-stack socket (IPv6 and IPv4, `session::dual_stack`; IPv4 alone where
  there's no IPv6), and pairing codes carry a few IPv6 addresses too
  (link-local ones without a scope; the scanning device tries each of its
  own, `check::candidates`). `Info.plist` declares the Bonjour service
  (`NSBonjourServices`), as Murmur's does. The fake Tauri layer records what's
  announced (`/fake-lan`). Trying every address at once leaves the other
  device with connections that close before they begin
  (`wire::CLOSED_UNOPENED`): not failures, so not noted. A sync or join
  notes the address it went through (`Outcome::via`).
- The UDP search stays beside it, so older versions still find each other:
  discovery answers on UDP 47831 and sync listens on TCP 47832 (or any free
  port), clear of Tally's 47821/47822, so both apps run side by side.
  Discovery's socket shares its port (`SO_REUSEADDR`/`SO_REUSEPORT`,
  `discovery::bind_responder`): an earlier version still installed, or a
  development build beside the real one, holds it too, and searches are
  broadcast, so each hears them. A taken port is noted in the diagnostics
  and shown by the connection check.
- `src/lib/syncBoot.ts` (imported by `main.tsx`) checks the database's
  instance before anything writes, starts sync, and refreshes the screens
  when another device's data arrives.
- `cargo test` (in `src-tauri`) runs the sync tests: random histories that
  must converge, pairing over real sockets, restored copies.
- Pairing (`src/screens/SyncPage.tsx`): either device shows the code (an SVG
  QR, black on white with the standard quiet zone). A phone scans it with the
  barcode plugin in windowed mode, the camera behind the app, under our own
  frame and Cancel (`phone-scanning` on `<html>`; the plugin's full-screen
  view has no way back); a computer scans with its webcam (jsQR); either can
  paste. A device that holds data asks after it has the code, then joins with
  `replace` (a backup first). `src-tauri/Info.plist` gives macOS the local
  network and camera descriptions; without the first, macOS blocks sync
  silently.
- Checking the connection (tandem.SYN-23, tandem.SYN-24; `src-tauri/src/sync/check.rs`,
  the Connection card on Settings → Sync): this device's networks, whether
  sync listens, which of the book's devices answer the search, and a timed
  connection to each device with an address (the book's, and the code last
  joined, kept by the service). "No route to host" is told apart by how soon
  it comes: macOS refuses at once (under 150 ms) when its Local Network
  privacy keeps the app off the network (Apple's TN3179), while a device
  that doesn't answer fails after seconds; a refusal means the app isn't
  open there, and the route (`route_from`) shows another network or a VPN.
  Join and sync errors carry the same meaning (`check::connect`), and one
  about Local Network offers System Settings
  (`x-apple.systempreferences:…`, allowed in the opener's scope). Each check
  is noted in the diagnostics. macOS ties the permission to the build, so
  an unsigned new version can need it turned on again. The check also asks
  the system which way this app's traffic for its own network would go
  (`route_from` a neighbour on each network): if it leaves from another
  interface (a phone's VPN, `vgate0` or `tun0`, or a per-app network
  setting), nothing on the network can reach the app, and the check says
  so. A device counts by its address on this network: a VPN address it
  also offers doesn't decide the verdict. Pairing codes leave out lone (/32)
  addresses, a VPN's or a gateway's.

## The book: pages and blocks

- One `blocks` table holds the whole book (`src/db/schema.ts`). A page is a
  block of type `page`; its content is the blocks whose `parent_id` is the
  page (nested: theirs). Siblings are ordered by `position`, a fractional
  index (`fractional-indexing`), so an insert or move writes one row. No
  foreign keys: sync applies rows in any order.
- Deleting marks `deleted_at`; rows are never removed. Every write to a block
  also writes a `revisions` row (`src/lib/book.ts`), with `page_id` the page
  it was on, so `pageAt` (`src/lib/bookModel.ts`) can rebuild a page at any
  moment. Moving a block to another page writes a revision for it and for
  everything nested in it.
- `src/lib/bookModel.ts` holds the decisions without I/O (content trees,
  `planSave`'s diff, positions, the page tree, history, Markdown) and is
  unit-tested; `src/lib/book.ts` does the queries.
- The editor is BlockNote (`src/components/PageEditor.tsx`). Its block ids are
  UUIDv4; a row's id is the TypeID of the same bits (`src/blocks/ids.ts`).
  Saves are debounced and write only what changed since the last save
  (`planSave` against a snapshot), so another device's edit to an untouched
  block is never overwritten. Changes from sync are taken in when the editor
  isn't focused, or on blur.
- Block types live in `src/blocks/`, one module each, mirroring
  `.spec/book/blocks/`. A type maps its stored form (type name, props,
  content) to the editor's and back. A new type is a new module added to
  `BLOCK_TYPES` (and its spec to `schema` if custom); storage and sync don't
  change. Rows of a type this build doesn't know show as a placeholder and
  are written back untouched (`src/blocks/unknown.tsx`).
- On a phone (BLK-5, BLK-6) a finger drags a block by its handle
  (`src/components/blockTouchDrag.ts`: touch events, a drop line, scrolling
  near the edges, then `removeBlocks` + `insertBlocks` in one `transact`,
  ids kept, so the save writes only the new position); HTML drag and drop,
  the editor's own, can't start from a finger in the WebView. The add button
  and the handle stack vertically in a 26px margin there.
- Inline maths is a `math` inline node (`$…$` input rule, KaTeX); links are
  `pageLink` nodes holding the page's (and block's) id, showing live titles
  from `src/lib/pageIndex.ts`. Code blocks highlight with Shiki (JS regex
  engine), Lean included.
- Spacing and sizes are CSS over BlockNote's (`src/App.css`), nothing
  stored: blocks stand `blocks.space` apart (BLK-7, a margin between
  `.bn-block-outer`s), except a list's items and everything nested in one
  (`:has()` on `data-content-type$="ListItem"`); headings take
  `heading.size-*` (HEAD-2) through BlockNote's `--level`, all below the
  page's title. Level 1 is set on every heading, since BlockNote leaves a
  default prop off as an attribute (an H1 has no `data-level`).
- `tsconfig.json` leaves `exactOptionalPropertyTypes` off: BlockNote's types
  don't hold under it.

## Lean blocks

A Lean block (`src/blocks/lean.tsx`, `src/components/LeanBlock.tsx`) is a
Lean 4 module: its name in the props (`Peano` is the module `Book.Peano`),
its source as the row's content (a JSON string). Blocks import each other
by name, from any page. Only computers run Lean (LEAN-7); phones write,
read and show verdicts.

- `src/lib/leanModel.ts` is pure (names, imports, the hash a verdict holds
  for, abbreviations); `src-tauri/src/lean/model.rs` computes the same names,
  imports and hashes, and both tests pin the same hash. A verdict holds for
  SHA-256 of `name\nsource` and for the hashes of every block it imports,
  transitively (`deps`); either changing makes it "not verified".
- Verdicts are rows of `lean_checks` (synced, keyed by the block's id: two
  computers verifying one block write one row), written by Rust.
- `src-tauri/src/lean/` is `#[cfg(desktop)]`; the commands (`lean_status`,
  `lean_set_up`, `lean_check`, `lean_goal`) are one-line errors on phones.
  The workspace is `<app data>/lean`: a Lake project requiring Mathlib
  (`master`, pinned by `lake update`; its toolchain copied in), set up from
  Settings → Lean with `lake +leanprover-community/mathlib4:lean-toolchain
  update`, `lake exe cache get`, `lake build`, each line sent as a
  `lean-setup` event. elan's `lake` is looked for in `~/.elan/bin` first (a
  Mac app doesn't get the shell's PATH). Named blocks are written to
  `Book/<Name>.lean` (only what changed; files of gone names removed), others
  are checked from `Scratch/<id>.lean`.
- Checking talks to one `lake serve` (`lsp.rs`, a JSON-RPC client generic over
  its streams; its tests use a stand-in server): open or change the file,
  `textDocument/waitForDiagnostics`, then the latest diagnostics for that
  version. A file whose imports changed is closed and opened again, so Lean
  rebuilds them. Goals: `$/lean/plainGoal`, then `$/lean/plainTermGoal`.
- On a computer the block is checked 0.9 s after typing pauses, as it is in
  the editor, whenever its verdict doesn't hold; every 30 s the service
  checks blocks another device changed (their `sync_rows.origin`) whose
  verdict doesn't hold (LEAN-6), and says so with a `lean-checked` event.
- The editor is a transparent textarea over Shiki's Lean highlighting in one
  grid cell (same metrics, so they line up), with errors and warnings
  underlined. Backslash abbreviations (`\to` → →) are replaced with
  `execCommand("insertText")`, so undo takes them back.
- `tests/browser/fake-tauri.ts` fakes the Lean commands (`sorry`, `#eval`,
  `type_mismatch` in a line), so the browser checks cover the block.

## The library

- Papers, books and blog posts (`src/lib/library.ts`; kinds `paper`,
  `book`, `post`): details in `library_items`, the PDF's bytes in
  `library_files` (one per item, kept apart so listing never reads
  megabytes). Both sync; removing an item deletes both rows.
- The bytes go through Rust (`src-tauri/src/library.rs`) as base64 strings
  both ways (`library_save_file`, `library_read_file`): the SQL plugin can
  only pass JSON, and raw IPC bodies (`invoke(cmd, bytes)`,
  `tauri::ipc::Response`) work on the desktop but don't reach Rust on
  Android. The browser encodes (`FileReader.readAsDataURL`); `bytesOf`
  decodes in slices. Writes made in Rust don't announce themselves, so the
  caller calls `notifyTablesChanged`.
- pdf.js (`src/lib/pdf.ts`, legacy build for the Android WebView) runs in a
  bundled worker; its fonts, character maps, colour profiles and wasm decoders
  are served from `/pdfjs/` by a plugin in `vite.config.ts`. The CSP allows
  `'wasm-unsafe-eval'` for those decoders.
- The viewer (`src/components/PdfViewer.tsx`) measures only page 1 on open
  (the rest take its size until drawn), draws pages near the view, and zooms
  by pinch, double tap, Ctrl/⌘ + wheel or its buttons, keeping the point
  under the fingers still. Pinch and taps are non-passive touch listeners
  (as in pdf.js; `.pdf-pages` has `touch-action: pan-x pan-y`, so one finger
  scrolls natively): a pinch scales the stack with a CSS transform and
  redraws when the fingers lift. On a phone, reading down puts the controls
  away (`pdf-reading` on `<html>`, a page pill shows instead); scrolling up or
  a tap brings them back; scrolls a zoom causes don't count. The page last
  read is kept per device (localStorage `pdf-page:<id>`), written only from
  scrolling so opening can't overwrite it. The page count goes to a page.
- Details are read by a model when an item is added (`src/lib/libraryDetails.ts`,
  in the background after the upload): the first three pages' text, or JPEGs
  of them for a scan, go to OpenRouter with a strict JSON schema
  (`chatJson` in `src/lib/openrouter.ts`); the prompt, schema and answer
  parsing are in `src/lib/libraryDetailsModel.ts`. The default model is
  `anthropic/claude-haiku-5.5`, changeable in Settings → AI and models (synced). Without a
  key, or when the call fails, the PDF's own metadata stands (XMP first,
  then the info dictionary; a PDF of 120 pages or more starts as a book).
  Logged in the ledger as `library_details`.
- An item's table of contents is the PDF's own outline (`pdfOutline` in
  `src/lib/pdf.ts`), taken when it's added and stored as JSON in
  `library_items.toc` (`TocEntry[]`, `parseToc` in `src/lib/schemas.ts`):
  `null` means not taken yet, and items added before get theirs the first time
  their PDF opens; `[]` means the PDF has none. The viewer shows it beside the
  pages (`src/components/Contents.tsx`, a sheet on phones), and the assistant
  gets it with an item's details.
- An item can also hold an HTML version (`library_html`, synced, one per
  item; LIB-24): from arXiv or an HTML file added like a PDF. It's stored
  self-contained and already sanitized: `src/lib/paperHtml.ts` cuts the paper
  out of the page (LaTeXML's `article.ltx_document`, or the body), tidies
  LaTeX's leftovers (`tidyPaper`: `.ltx_ERROR` commands, author notes,
  whatever comes before the title, such as affiliation logos; SVG figures in
  `<object>`s become `<img>`s), drops scripts and chrome, moves each
  formula's TeX annotation into its `alttext`
  and unwraps `<semantics>` (DOMPurify would otherwise show the TeX as text),
  inlines figures as `data:` URLs, and sanitizes with DOMPurify (HTML, MathML,
  SVG); a figure that can't be fetched is dropped. Where it's shown
  (`HtmlReader.tsx`) it goes through `readablePaper`: tidied and sanitized
  again, so versions stored before the tidying improved read as well. Its sections
  (`section[id]` with a heading, else headings) are the contents, as
  `TocEntry`s with an `anchor`. An item opens as text on a phone and as its
  PDF on a computer unless `?view=text|pdf` says; read as text, the fragment
  is the section at the top of the view. The Text|PDF switch sits in the
  viewer's own bar, beside Contents, so the item's bar keeps room for the
  title; on a phone, reading down as text steps everything around it aside,
  as the PDF viewer does (`pdf-reading`). The assistant reads it a section at
  a time (`read_section`, maths as `$LaTeX$`) and gets the section in view.
- Adding from arXiv (`src/lib/arxiv.ts`, pure parsing in `arxivModel.ts`):
  an identifier in any form, arXiv's Atom listing (its title, authors and
  year stand over what the model reads; the model adds institutions only
  when it read the same number of authors), `arxiv.org/pdf/<id>`, and the
  HTML version from `arxiv.org/html/<id>` or else `ar5iv.labs.arxiv.org`
  (figures named from the page's address, or its `<base>`, as a browser
  reads them: arXiv's `2611.21885v2/x1.png` beside `/html/2611.21885`).
  Items carry `arxiv_id`; adding one already there opens it, and its ⋯ menu
  fetches the HTML version again (`refetchArxivHtml`). The fake Tauri layer
  answers as arXiv for `1706.03762`, its page shaped like arXiv's own.
- Adding a blog post by its address (LIB-28; `src/lib/web.ts`, pure parts
  in `webModel.ts`): the Library's field takes an arXiv number or any web
  address. Rust fetches the page (`web_get` in `src-tauri/src/web.rs`: a
  plain GET with a browser's user agent, no cookies, http(s) only, at most
  `library.max-file-size`; figures go the same way). A PDF there (as its
  type says, or its first bytes: LIB-29) is added as the file would be,
  named from the address (`pdfName`); a page goes to Mozilla's Readability,
  which finds the post in it. A page that builds itself in the browser
  (z.ai's blog: an empty `<div id="root">`) reads as too little (`MIN_ARTICLE_TEXT`), so it's
  rendered (`web_render`) and read again: on a computer a hidden
  `WebviewWindow` of the app's webview (`page-render-N`, in no capability,
  so the page can't call the app), its HTML taken with `eval_with_callback`
  once its text stops growing; on Android the `page-render` plugin
  (`src-tauri/plugins/page-render`, an off-screen WebView; only the APK build
  compiles its Kotlin). Before Readability, KaTeX's and MathJax's drawings
  give way to their MathML; after it, videos and embedded players become
  links, and the post goes through `paperOf` (chrome out, headings named)
  with its title as an `<h1>` without an id (not one of its sections), its
  figures inlined and sanitized, as arXiv's HTML is. The item's `filename`
  is the address it was read at (after redirects), also its HTML's
  `source_url`, by which adding it again finds it. Title, byline and date
  come from the page (Readability's metadata, a heading that holds the
  short title, `time[datetime]`) and stand over the model's
  (`readDetails`' `post`); the model reads the post and the top of the
  page around it, and never changes a post's kind. Without a PDF,
  `readDetails` reads an item's stored text. The fake Tauri layer answers
  as two blogs (`blog.example.com`, served as HTML; `spa.example.com`, a
  shell until rendered) and serves a PDF at
  `papers.example.com/files/on-loops.pdf`.
- Sharing to the app (LIB-30): on Android the app is in the share sheet for
  text (a web address) and PDFs. `scripts/android-share.mjs` adds the
  filters (`SEND` text/plain and application/pdf, `SEND_MULTIPLE` PDFs) to
  the generated manifest's main activity, so a share reaches the running app
  as a new intent (it's singleTask) with the grant to read its files; CI runs
  it after `tauri android init`, beside the signing and icons scripts.
  `src-tauri/plugins/share-target` (`ShareTargetPlugin.kt`) keeps what
  arrives (the intent that started the app, unless it came from the recent
  apps, or a new one) until the frontend takes it (`take`: each file read
  then, base64, without its bytes when over `library.max-file-size`) and
  says `shared` when one arrives. `src/lib/share.ts` takes shares when the
  app starts (from the layout, once it can navigate), when it comes to the
  front and on `shared`, and opens the Library, which adds each as if typed
  in its field (`sharedAddress` in `webModel.ts`: the text when it's an
  address or arXiv number, else its first web address) or uploaded; each is
  noted in the diagnostics. Elsewhere `take` gives nothing. The fake Tauri
  layer hands over what the checks post to `/fake-share`.
- Authors and institutions are records (`people`, `institutions`), linked to
  items through `authorships` (ordered) and `affiliations` (an author's
  institutions on one item). New names link to an existing record when
  exactly one matches (`src/lib/peopleModel.ts`: same normalised words, or
  for people the same surname with agreeing first names or initials).
  Merging sets `merged_into` instead of rewriting links, so links made
  concurrently elsewhere still land; readers resolve chains, and a cycle
  from merges on two devices resolves to its smallest id everywhere.
  `library_items.authors` is a display line kept in step with the
  authorships (lists and search read it). Above what's read, an item shows
  the first three names, each a link to the person (PPL-8); "and N more"
  opens the whole list with institutions (`AuthorsEditor`, not editing).

## Look and feel

- The app is Commonplace (`app.name`); the logo is a C of page edges with a
  ribbon tucked between the pages, hanging out below. Every form of it comes
  from one geometry in `scripts/logo.mjs` (`node scripts/logo.mjs`): the
  SVGs (`src/assets/logo.svg`, `logo-round.svg`,
  `logo-android-foreground.svg`, `public/favicon.svg`), `app-icon.png`,
  `.spec/assets/logo.png` and Android's PNGs. `bun run tauri icon
  app-icon.png` makes the desktop icons from it; then run the script again
  and `git checkout src-tauri/icons/android/mipmap-anydpi-v26` (and drop
  `src-tauri/icons/ios`), since `tauri icon` writes over Android's. Android has its own set in
  `src-tauri/icons/android` (an adaptive icon: the mark from
  `logo-android-foreground.svg` over the logo's ink blue, plus `logo-round.svg`
  and the logo for older launchers); `tauri icon` would overwrite it, so
  restore that folder after running it. `scripts/android-icons.mjs` copies it
  into the generated Android project (CI runs it after `tauri android init`). The identifier is
  `com.madsbuch.commonplace` (`app.identifier`, APP-13). It was
  `com.madsbuch.mybook`: on a computer, `src-tauri/src/earlier.rs` moves the
  old folders over the first time it starts (the database with its instance
  marker, so the device stays the same device); a phone gets the new app
  beside the old one, empty, and joins the book. Sync's wire names
  (`MYBOOK/1`, `mybook-pair:`, `mybook-book:`), the Kotlin packages of our
  plugins (`com.madsbuch.mybook.*`, which the JNI entry point is named after)
  and the crate (`my-book`) keep the old name: they're internal, and changing
  the wire names would stop old and new versions syncing.
- Colours are tokens in `src/App.css`, the spec's `color.*` values, light and
  dark. `src/lib/theme.ts` sets `data-theme` on `<html>` before the first
  paint (the choice is per device, in localStorage), animates a switch with
  View Transitions (a circle from the button pressed) or a colour
  cross-fade where they're missing, and respects reduced motion. Mantine and
  BlockNote take the theme from `useColorScheme()`, never from the system.
- Fonts are bundled (`@fontsource-variable/literata` for the book,
  `@fontsource-variable/inter` for the interface), imported in `main.tsx`.
- `Ctrl+K` / `⌘K` opens the page search (`src/components/QuickOpen.tsx`).
- Every screen has an address, and the address holds what the screen shows
  within it (APP-10), kept current by replacing, never pushing (APP-11), so
  Back leaves the screen. Where it's scrolled to is the fragment: `#page=12`
  on a library item (the PDF page in view), `#blk_…` on a page (the block at
  the top of the view). `replaceFragment` (`src/lib/address.ts`) writes it
  straight to `history.replaceState`, past the router, at most every 250ms
  (WebKit refuses floods), and only while the same screen is up; so the
  router's location changes only on navigations, and screens react to those
  (`location.key`) to jump. What's chosen is the query, through
  `useQueryParam` (library `tab`/`q`/`kind`, history `at`, costs `range`). A
  new screen, or new state on one, goes in the address and in `ROUTES`.
  Assistant answers may link to addresses; `Markdown.tsx` opens them in the
  app.
- Settings (`/settings`) holds only rows (`src/components/SettingsRows.tsx`),
  each with a line on how its part stands, opening a page nested in it:
  `/settings/ai` (the OpenRouter key and models), `/settings/sync`,
  `/settings/costs`, the memory and `/settings/diagnostics`; the theme
  switch sits in its row. A new
  setting goes on a nested page (or a new row and page), never on Settings
  itself (APP-8). A new route also goes in `ROUTES` (`src/lib/currentView.ts`).
- Explanations of how something works go behind an ⓘ
  (`src/components/InfoButton.tsx`, a sheet on phones), never as grey text on
  the screen; the screen's text says how things stand (APP-9). The ⓘ can
  pulse while what it explains is under way (`tone="busy"`) or turn the
  warning colour when it failed (`tone="warning"`), with the details inside.

## The audio library

Recordings of library items (`recordings`, synced): each item's one
reading, verbatim (AUD-2), and summaries of several, one narrator, 5/15/30
minutes, recordings of their own. A reading's id is derived from its item's
(`readingId`: `derivedId("recordings", "reading:<item>")`), so every device
starts the same one. It's listened to from the item's contents
(`src/lib/listening.ts`, `listenFrom`): a ▶ on each section (`#t=` its
chapter's start, `sectionStart`) and a Beginning row, or ⋯ → Listen, where
it was left; it plays on. It keeps the voice it
began in, and "Read in another voice…" (AUD-15, `readInVoice`) drops its
pieces and keeps its text and where it was left. A recording is made as it's
listened to (AUD-6), `audio.lead` (3 min) ahead of the listener, on whichever
device plays it, or all of it at once when asked (AUD-13, on the device that
asked: `device`). A summary keeps its script and `provenance` (AUD-16: its
works and which of their texts, the script model and its instructions, its
length, the speech model and voice, when and where), shown folded away on
its screen (`WhereItCameFrom`); a reading's chunks keep the `model` that
wrote them. An item's recordings from before it had one reading (a section,
the whole of it, made a piece at a time) are taken into its reading when the
app starts (`adoptEarlier` → `audio_adopt` → Rust's `take_in`: their chunks
by source, their pieces by `speech_key`), then deleted; ones made at once as
one file stay as they are.

- The app prepares the script (`src/lib/audio.ts`, `prepareScript`; pure
  parts in `audioModel.ts`): an item's sections from its HTML version (each
  without the sections in it, the front matter first, the bibliography left
  out; a `section` element's own text, or where the sections are only
  headings, as in a post, a heading and what follows up to the next, taken
  with a DOM Range, `between`), or from its PDF by its contents' pages and
  titles, cut into chunks
  (`MAX_SCRIPT_CHUNK`) with `passages: null`; a summary is written whole here
  (one call, `audio_script` in the ledger). The script's shape is
  `{ chapters: [{ title, key, chunks: [{ source?, passages, model? }] }] }`
  (`key`: the section, `html:<anchor>`, `toc:<i>` or `front`); recordings
  made before hold `{ title, paragraphs }` chapters, read as one written
  chunk each. Status: `writing` → `listening` (or `making`) → `ready`. A
  reading follows its item's text (AUD-17, `refreshReading`: when listening starts, and
  when the app starts for readings of HTML versions): prepared afresh
  (`scriptOf`, keeping chunks whose source is unchanged), and if its
  chapters or chunks differ Rust lays the reading over it (`audio_reshape` →
  `lay_over`): pieces go where their passages now are, by `speech_key`;
  those not placed yet (their chunk to be written again) are kept aside as
  `<id>.parked.<key>` rows (chapter -1, out of the timeline) for
  `spoken_before` to find, and dropped once placed; where it was left
  follows its piece.
- Rust makes it (`src-tauri/src/audio/`): `plan.rs` is pure (slots in order,
  a piece per passage, `<recording>.<chapter>.<chunk>.<passage>`, and what
  to make next within the lead, or all), `script.rs` writes a chunk through
  the script model (the prompt is `verbatim.md`, the one copy; structured
  JSON, `ai.most-answer.audio-script`; logged as `audio_script` with its
  cost), and `render.rs`'s `AudioService` runs a worker per recording:
  `listen(id, piece)` (from the web view's player every 5 s while playing, on
  a seek, or Android's player's state, asked every 3 s) aims it, it writes
  the chunk reached, then speaks up to three passages at once through
  OpenRouter's `/audio/speech` (raw PCM asked for; `speech` rows in the
  ledger count characters), each into a piece of its own (`OpusStream`,
  `opus-pure`, pure Rust: it builds for Android; 24 kbit/s mono, 24 kHz,
  our own WebM writer, `webm.rs`), the pause after it included, in
  `recording_pieces` (synced: any device plays what's made, and two making
  the same passage make the same row). What another recording made is used
  again (AUD-14): a chunk whose source another script has written already
  takes its passages (`written_elsewhere`; a section's chunks are the same
  text in the whole paper's script, which the browser checks hold to), and
  a passage spoken in the same voice is the same piece, found by its
  `speech_key` (SHA-256 of the speech model, voice and text) and copied. So
  a piece is the same wherever it falls: no lead-in, and its pause comes from
  its own text (`pause_after`: a heading's longer). Pieces made before the
  key get it when the app starts (`name_pieces`). With nothing left in the lead it
  waits for the listener to move on, and stops after 10 min. `make_all`
  makes the rest in order; `resume` (in `sync_start`) carries on `making`
  ones, and old `speaking` ones (their `speech_clips`, local, are used and
  dropped). It emits `audio-piece`, `audio-progress` and `audio-changed`.
  Ogg Opus would be simpler, but Safari plays WebM Opus reliably and Ogg not.
- Recordings made before, at once, are one file (`recording_files`): only
  they have `duration_seconds` and `chapters`, and they play as one.
- `tests/browser/fixtures/speech.webm` is our encoder's output
  (`WRITE_SPEECH_FIXTURE=… cargo test speech_in_opus`). The fake Tauri layer
  makes pieces with it as Rust would (`audio_listen`: from the listener on,
  each chunk reached is "written", its request recorded, unless another
  recording wrote its source already, until two passages are, and those are
  made, with their `speech_key`; `audio_make_all`: all; `audio_make_chapter`:
  one; `audio_adopt` and `audio_reshape`, as `take_in` and `lay_over`), so
  the browser checks play real WebM Opus from a section, wait for what isn't
  made, go on, make a chapter now, take in a section recorded before, and
  reshape a post's reading prepared the old way.
- One player for the app (`src/lib/player.ts`): a recording's timeline
  (`timeline` in `audioModel.ts`: pieces made count as they are, the rest at
  the pace of what's made), chapters, speed (per device), where it was left
  saved every 5 s and on pause (`listening`: seconds into its `piece`; synced),
  and `#t=<seconds>` in the recording's address. At a part not yet made it
  waits (`waiting`, "Making this part…") and goes on when the piece arrives.
  Its chapters show how much of each is made (AUD-18, `Timeline.made`, each
  with its section's key) and a chapter not yet made can be made now
  (`makeChapter` → `audio_make_chapter`: the worker's target holds chapters
  to make, each after what's ahead of the listener, `plan::next_in_chapter`).
- Listening lives in the item's Contents (`Contents.tsx`'s `listen`):
  `listenEntries` (`audioModel.ts`) matches each entry to its chapter by key
  (`html:<anchor>`, `toc:<i>`), else by title; before there's a reading, the
  bibliography offers none. Each row has a `MadeRing` (how much is made, a
  ✓ when all; pressed, it makes the section now) and a ▶; the section being
  heard is marked (AUD-19). "Follow" in the contents' head (per device,
  localStorage `follow-audio`) keeps the heard section in view, the HTML's
  anchor or the PDF's page, until the author scrolls. The recording screen
  shows a reading's chapters as the same contents (`ReadingContents`), with
  times; a summary's as a list.
  On a computer, two audio elements on Blobs (`audio_piece`, base64), the
  next piece loaded while one plays; Media Session for media keys.
  `MiniPlayer` shows what's playing on other screens.
- On Android the player is native (AUD-10): `src-tauri/plugins/audio-player`,
  ported from learn-polish's song player. Media3 ExoPlayer in a
  `MediaSessionService` (foreground, plays with the screen off and keeps
  Wi-Fi awake, `WAKE_MODE_NETWORK`, since pieces are made while it plays;
  notification with a Close button; headphones unplugged pause). Its queue is
  set by Rust (`audio_native_play` → `play_native`: the made pieces around
  where it starts, a file each under `<app data>/recordings/<id>/`, via
  `.part`; a recording made before, its one file), which adds pieces as
  they're made (`extendQueue`: one that played to its end waiting goes on)
  and asks it where it is (`getState`), so making keeps ahead, and where it
  was left is kept, with the web view stopped. `ChapterPlayer` (a
  `ForwardingPlayer`) makes the lock screen's next and previous skip chapters
  (a piece's chapter is in its id; a file's at `starts`). The web view's
  player uses its `play`, `pause`, `seek_to`, `set_speed`, `stop` and its
  `state` events; `audio-player:default` is in the mobile capability. Only
  the APK build (CI) compiles its Kotlin.

## Diagnostics and work in the background

- The diagnostics (DIAG-*) are a log per device: the `diagnostics` table
  (local, never synced), kept 14 days and at most 5,000 entries
  (`diagnostics.kept`, `diagnostics.most`; trimmed at start). The frontend
  notes through `note(level, source, message, details)` in
  `src/lib/diagnostics.ts` (queued, written in batches; noting never
  throws): uncaught errors and rejections and console errors/warnings
  (`installDiagnostics`, first thing in `main.tsx`), every screen the router
  opens, failed model requests and their retries (`openrouter.ts`), and a
  screen's failure line (`useNotedProblem(source)` in place of
  `useState<string | null>`). Rust notes through
  `src-tauri/src/diagnostics.rs` (`report`, `report_with`): sync, recordings,
  Lean; entries wait in memory until the database is open (`flush` in
  `sync_start`). A panic is appended to `crashes.jsonl` beside the database
  and taken in at the next start. Keys (`sk-or-…`, `Bearer …`) are masked
  when noted and again when copied (`maskKeys`, Rust `mask`). Rust errors
  are written with their whole cause (`diagnostics::chain`): reqwest's
  "error sending request" alone says nothing.
- `/settings/diagnostics` (`DiagnosticsPage.tsx`) shows the build, what
  runs, and the log as one `<pre>` (newest first, an entry a line with its
  details indented under it, as learn-polish shows its log;
  `?show=failures`), and copies everything as one text for a coding agent
  (`diagnosticsReport.ts` gathers, `diagnosticsModel.ts` formats; falls back
  to a selected textarea if the clipboard refuses). CI stamps each build
  with its commit and time (`VITE_BUILD_COMMIT`, `VITE_BUILD_TIME`;
  `src/lib/build.ts`), so a pasted log says which build it came from.
- New work that runs by itself goes through `beginWork(source, title)` /
  `asWork` (`src/lib/work.ts`), or in Rust `Work::begin`/`end`
  (`src-tauri/src/work.rs`). That notes it in the diagnostics and keeps it
  going out of sight (WORK-1): while anything runs, the
  `background-work` plugin (`src-tauri/plugins/background-work`) runs an
  Android foreground service (type dataSync, a partial wake lock, a
  notification listing what runs; `WorkService.kt`), and on a computer holds
  `caffeinate -i` / `systemd-inhibit` so it doesn't sleep. Android won't
  start that service with the app in the background, so work begins where
  the app is in front: a recording made at once begins when asked; one made
  ahead of the listener as it plays, the player's own foreground service
  keeping the app going meanwhile.
- Requests that fail for the network (no connection, dropped, 408/425/429/5xx)
  are tried again for up to three minutes (`work.network-patience`:
  `NETWORK_WAITS_MS` in `openrouter.ts`, `NETWORK_WAITS` in
  `audio/render.rs`), each try noted.
- The fake Tauri layer keeps work as Rust would (`/fake-work` lists every
  begin and end) and answers `plugin:app|version`/`identifier`.

## AI

Every model call goes through `src/lib/openrouter.ts`: OpenRouter's chat
completions, streamed, with the author's own key, through the HTTP plugin
(`https://openrouter.ai/*`; the `http` capability's only other hosts are
arXiv's, for fetching papers, where nothing but an identifier goes).
Book content leaves the device only that way. (Blog posts are fetched by
Rust, `web_get` and `web_render`, with nothing but their address.)

- The key and the assistant's model are synced `settings`
  (`src/lib/aiSettings.ts`); the model list is fetched live and cached per
  device (`models_cache`, `models_cache_at`), the cache shown until the fetch
  returns.
- Every response that reports its cost is logged in `ai_usage` under its
  feature (`AI_FEATURES` in `src/lib/aiCost.ts`). A new feature that calls a
  model gets a name there and passes it as `feature`, and a most for its
  answers in `MOST_ANSWER` (`openrouter.ts`, the spec's `ai.most-answer.*`;
  AI-7): every request sends it as `max_tokens`, since without one
  OpenRouter holds back credit for the model's whole output limit and a
  few requests at once ask for more than the account holds (402). An answer
  cut off there (`finish_reason` "length") fails for JSON and for a round
  with tool calls; an assistant answer keeps its text and says it was cut
  off. The fake Tauri layer cuts a scripted reply with `cut: true`.
  `aiCost.ts` is pure (the Costs screen's roll-ups); `aiUsage.ts` reads and writes the ledger.
- The assistant is a chat (`src/lib/assistantRunner.ts`, a state machine
  outside React, like Tally's): transcripts are rows of `chats` (JSON,
  OpenAI-style, tool calls included) saved after every round; sync splits a
  chat continued on two devices at once (SYN-20, the engine's `chats` rule).
  It opens beside every screen (`AssistantDock`, on the chat last open on
  this device) and on its own at `/chats/<id>`. A question another device
  saved, unanswered, in the last 10 minutes waits for that device's answer.
- It reads by itself through tools (`src/lib/assistantTools.ts`):
  `look_at_screen`, pages, the library, PDF text, people and institutions.
  `look_at_screen` gives the address with `ROUTES` (what each kind of
  address shows; a test checks every route in `router.tsx` is there), the
  author's selection, the block the cursor is in, the PDF page in view
  (`src/lib/currentView.ts`), and a picture of the screen
  (`src/lib/screenshot.ts`: drawn from the DOM with modern-screenshot,
  without the assistant, at most 1280px wide). The picture is sent as a
  `user` message with `attachment: "screenshot"` after the tool results,
  only to models that take images, and `forStorage` strips it before the
  chat is saved. The selection is tracked from `selectionchange` and kept
  when focus moves into the assistant; PDFs have pdf.js's text layer so
  their text can be selected. Every read goes through `src/lib/lookup.ts`, which
  exposes no writes. It writes only its chats and its memory
  (`assistant_memory`, `src/lib/memory.ts`), which every turn carries.
- It never adds or changes anything in the book or the library. ESLint
  enforces it: assistant modules (`assistant*`, `entities`, the chat
  components) can't import `db`, `db/schema`, `book*`, `blocks*`,
  `revisions*`, `library*`, `people*`, drizzle, the SQL plugin or `invoke`.
- Ids in its answers (`blk_`, `lib_`, `person_`, `institution_`) render as
  chips with live titles (`src/components/Markdown.tsx`, `EntityChip.tsx`).
- Its ways of helping follow the spec's `assistant.actions` (`spec` field;
  `label` is the button's wording) and its topics `book.topics`;
  `tests/ai-assistant.test.ts` checks both against the spec.
- Links in model output open in the system browser (`openUrl`), never in the
  app's window.

## Commands

- `bun run dev`: Vite dev server
- `bun run tauri dev`: the app in development. It always runs as
  "Commonplace Dev" with data of its own, never as the real app:
  - desktop: `scripts/tauri.mjs` adds `src-tauri/tauri.dev.conf.json`
    (`com.madsbuch.commonplace.dev`); a debug build started any other way under
    the real identifier refuses to start (`src-tauri/src/lib.rs`);
  - Android: debug builds are the package `com.madsbuch.commonplace.dev`
    (`bundle.android.debugApplicationIdSuffix`), installed beside the real app.
- `bun run build`: typecheck `src/`, lint everything, and bundle
- `bun run lint`: ESLint only
- `bun test`: the test suite, including the spec check and sync tracking
- `cargo test` (in `src-tauri`): the Rust tests, sync's included
- `bun run test:browser`: drives the editor in Chromium against real SQLite
  (`tests/browser/`: the Tauri SQL plugin is stood in for by
  `fake-tauri.ts`, injected by `fake-tauri-init.js`)
- `bun run tauri icon app-icon.png`: regenerate icons from `app-icon.png`

Dependencies install only once published for two weeks (`bunfig.toml`,
`keel.deps-minimum-age`).

## CI

- `check.yml`: `bun test` and `bun run build` on every push.
- Caching: every build caches Rust compiler outputs with sccache (GitHub's
  cache backend; it keeps each variant of the Tauri crates, which the CLI
  and Gradle, or the two macOS targets, build differently), the target folder
  and registry with rust-cache (per platform, kept on failure), Bun's
  packages, and on Android the NDK and Gradle. A push supersedes a run still
  going for the same branch (`concurrency`).
- `android-apk.yml`, `macos.yml`, `linux.yml`: on push to main, build the
  apps and publish them to the `latest` release.
- `android-apk.yml` also checks the migrations on SQLite 3.39
  (`tools/sqlite-android-compat`).
- Android: `src-tauri/gen/android` isn't committed yet. CI generates it with
  `tauri android init --ci`, adds release signing with
  `scripts/android-signing.mjs`, the icons with `scripts/android-icons.mjs`
  and the share sheet's filters with `scripts/android-share.mjs`. Once
  generated locally (needs the Android SDK and NDK), commit it and run the
  scripts once; CI then uses it as is.
- Release signing for Android reads the secrets `ANDROID_KEYSTORE` (base64),
  `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`; without them the APK
  is unsigned. macOS builds are signed ad hoc (`bundle.macOS.signingIdentity`
  `"-"`, no hardened runtime; ENG-7): since macOS 15, an unsigned app is kept
  off the local network without being asked ("No route to host"), and sync
  can't reach out. Not notarized. Incoming connections aren't held back
  (TN3179), so another device can still reach an unsigned computer.
