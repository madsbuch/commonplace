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
  `PAR-`/`HEAD-`/`LIST-`/`CODE-`/`LEAN-` (block types), `LNK-` (links), `LIB-` (library), `PPL-` (people and institutions), `AST-`
  (assistant), `CHAT-` (chats), `ATL-` (assistant tools), `MEM-` (memory), `AI-` (models and costs), `APP-` (app), `STO-` (storage),
  `SYN-` (sync), `ENG-` (engineering), `DEV-` (development builds), `TRG-`
  (sync triggers), `ID-` (row ids). Stories use `US-`. Requirements keep their
  id when moved, so older prefixes (e.g. `BOOK-5` under revisions) appear
  outside their home item.
- A new block type is a new item in `.spec/book/blocks/` with its own prefix.
- The spec never names code; code names the spec. Code or a test that exists
  to meet a requirement carries `// Spec: SYN-1` (ids only) on its own line.
  When a requirement changes, search for its id.
- Constants in the code follow the spec's named values; change both together.
- `tests/spec.test.ts` (part of `bun test`) checks the spec: schema, unique
  ids, references, histories, and that every `Spec:` citation names a real
  requirement.

## JSON boundary rule

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
  `LOCAL_TABLES` (`scripts/sync-triggers.ts`: `device_settings` and sync's
  own bookkeeping). Sync rides on triggers: a migration that adds a table
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
- Discovery answers on UDP 47831 and sync listens on TCP 47832 (or any free
  port), clear of Tally's 47821/47822, so both apps run side by side.
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

- Papers and books (`src/lib/library.ts`): details in `library_items`, the
  PDF's bytes in `library_files` (one per item, kept apart so listing never
  reads megabytes). Both sync; removing an item deletes both rows.
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
  out of the page (LaTeXML's `article.ltx_document`, or the body), drops
  scripts and chrome, moves each formula's TeX annotation into its `alttext`
  and unwraps `<semantics>` (DOMPurify would otherwise show the TeX as text),
  inlines figures as `data:` URLs, and sanitizes with DOMPurify (HTML, MathML,
  SVG). It's sanitized again where it's shown (`HtmlReader.tsx`). Its sections
  (`section[id]` with a heading, else headings) are the contents, as
  `TocEntry`s with an `anchor`. An item opens as text on a phone and as its
  PDF on a computer unless `?view=text|pdf` says; read as text, the fragment
  is the section at the top of the view. The assistant reads it a section at
  a time (`read_section`, maths as `$LaTeX$`) and gets the section in view.
- Adding from arXiv (`src/lib/arxiv.ts`, pure parsing in `arxivModel.ts`):
  an identifier in any form, arXiv's Atom listing (its title, authors and
  year stand over what the model reads; the model adds institutions only
  when it read the same number of authors), `arxiv.org/pdf/<id>`, and the
  HTML version from `arxiv.org/html/<id>` or else `ar5iv.labs.arxiv.org`
  (figures relative to the page's address as a folder). Items carry
  `arxiv_id`; adding one already there opens it. The fake Tauri layer answers
  as arXiv for `1706.03762`.
- Authors and institutions are records (`people`, `institutions`), linked to
  items through `authorships` (ordered) and `affiliations` (an author's
  institutions on one item). New names link to an existing record when
  exactly one matches (`src/lib/peopleModel.ts`: same normalised words, or
  for people the same surname with agreeing first names or initials).
  Merging sets `merged_into` instead of rewriting links, so links made
  concurrently elsewhere still land; readers resolve chains, and a cycle
  from merges on two devices resolves to its smallest id everywhere.
  `library_items.authors` is a display line kept in step with the
  authorships (lists and search read it).

## Look and feel

- The app is Commonplace (`app.name`); the logo is `src/assets/logo.svg`,
  rendered to `app-icon.png` (`bun run tauri icon app-icon.png` makes the
  desktop icons) and `.spec/assets/logo.png`. Android has its own set in
  `src-tauri/icons/android` (an adaptive icon: the mark from
  `logo-android-foreground.svg` over the logo's ink blue, plus `logo-round.svg`
  and the logo for older launchers); `tauri icon` would overwrite it, so
  restore that folder after running it. `scripts/android-icons.mjs` copies it
  into the generated Android project (CI runs it after `tauri android init`). The bundle id is still
  `com.madsbuch.mybook`, so existing data stays where it is.
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
  `/settings/costs`, and the memory; the theme switch sits in its row. A new
  setting goes on a nested page (or a new row and page), never on Settings
  itself (APP-8). A new route also goes in `ROUTES` (`src/lib/currentView.ts`).
- Explanations of how something works go behind an ⓘ
  (`src/components/InfoButton.tsx`, a sheet on phones), never as grey text on
  the screen; the screen's text says how things stand (APP-9). The ⓘ can
  pulse while what it explains is under way (`tone="busy"`) or turn the
  warning colour when it failed (`tone="warning"`), with the details inside.

## AI

Every model call goes through `src/lib/openrouter.ts`: OpenRouter's chat
completions, streamed, with the author's own key, through the HTTP plugin
(`https://openrouter.ai/*`; the `http` capability's only other hosts are
arXiv's, for fetching papers, where nothing but an identifier goes).
Book content leaves the device only that way.

- The key and the assistant's model are synced `settings`
  (`src/lib/aiSettings.ts`); the model list is fetched live and cached per
  device (`models_cache`, `models_cache_at`), the cache shown until the fetch
  returns.
- Every response that reports its cost is logged in `ai_usage` under its
  feature (`AI_FEATURES` in `src/lib/aiCost.ts`). A new feature that calls a
  model gets a name there and passes it as `feature`. `aiCost.ts` is pure (the
  Costs screen's roll-ups); `aiUsage.ts` reads and writes the ledger.
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
    (`com.madsbuch.mybook.dev`); a debug build started any other way under
    the real identifier refuses to start (`src-tauri/src/lib.rs`);
  - Android: debug builds are the package `com.madsbuch.mybook.dev`
    (`bundle.android.debugApplicationIdSuffix`), installed beside the real app.
- `bun run build`: typecheck `src/`, lint everything, and bundle
- `bun run lint`: ESLint only
- `bun test`: the test suite, including the spec check and sync tracking
- `cargo test` (in `src-tauri`): the Rust tests, sync's included
- `bun run test:browser`: drives the editor in Chromium against real SQLite
  (`tests/browser/`: the Tauri SQL plugin is stood in for by
  `fake-tauri.ts`, injected by `fake-tauri-init.js`)
- `bun run tauri icon app-icon.png`: regenerate icons from `app-icon.png`

Dependencies install only once published for two weeks (`bunfig.toml`).

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
  `tauri android init --ci` and adds release signing with
  `scripts/android-signing.mjs`. Once generated locally (needs the Android
  SDK and NDK), commit it and run the script once; CI then uses it as is.
- Release signing for Android reads the secrets `ANDROID_KEYSTORE` (base64),
  `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`; without them the APK
  is unsigned. macOS builds are unsigned.
