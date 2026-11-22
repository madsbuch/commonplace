# My Book

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
  `PAR-`/`HEAD-`/`LIST-`/`CODE-` (block types), `LNK-` (links), `LIB-` (library), `PPL-` (people and institutions), `AST-`
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
- Inline maths is a `math` inline node (`$…$` input rule, KaTeX); links are
  `pageLink` nodes holding the page's (and block's) id, showing live titles
  from `src/lib/pageIndex.ts`. Code blocks highlight with Shiki (JS regex
  engine), Lean included.
- `tsconfig.json` leaves `exactOptionalPropertyTypes` off: BlockNote's types
  don't hold under it.

## The library

- Papers and books (`src/lib/library.ts`): details in `library_items`, the
  PDF's bytes in `library_files` (one per item, kept apart so listing never
  reads megabytes). Both sync; removing an item deletes both rows.
- The bytes go through Rust (`src-tauri/src/library.rs`) as raw IPC bodies:
  `invoke("library_save_file", bytes, { headers })` and
  `library_read_file` answering with `tauri::ipc::Response`. The SQL plugin
  can only pass JSON. Writes made in Rust don't announce themselves, so the
  caller calls `notifyTablesChanged`.
- pdf.js (`src/lib/pdf.ts`, legacy build for the Android WebView) runs in a
  bundled worker; its fonts, character maps, colour profiles and wasm decoders
  are served from `/pdfjs/` by a plugin in `vite.config.ts`. The CSP allows
  `'wasm-unsafe-eval'` for those decoders.
- Details are read by a model when an item is added (`src/lib/libraryDetails.ts`,
  in the background after the upload): the first three pages' text, or JPEGs
  of them for a scan, go to OpenRouter with a strict JSON schema
  (`chatJson` in `src/lib/openrouter.ts`); the prompt, schema and answer
  parsing are in `src/lib/libraryDetailsModel.ts`. The default model is
  `anthropic/claude-haiku-5.5`, changeable in Settings (synced). Without a
  key, or when the call fails, the PDF's own metadata stands (XMP first,
  then the info dictionary; a PDF of 120 pages or more starts as a book).
  Logged in the ledger as `library_details`.
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

## AI

Every model call goes through `src/lib/openrouter.ts`: OpenRouter's chat
completions, streamed, with the author's own key, through the HTTP plugin
(`https://openrouter.ai/*` is the only host the `http` capability allows).
Book content leaves the device only that way.

- The key and the assistant's model are synced `settings`
  (`src/lib/aiSettings.ts`); the model list is fetched live and cached per
  device (`models_cache`, `models_cache_at`), the cache shown until the fetch
  returns.
- Every response that reports its cost is logged in `ai_usage` under its
  feature (`AI_FEATURES` in `src/lib/aiCost.ts`). A new feature that calls a
  model gets a name there and passes it as `feature`. `aiCost.ts` is pure (the
  Costs screen's roll-ups); `aiUsage.ts` reads and writes the ledger.
- The writing assistant (`src/components/AssistantPanel.tsx`,
  `src/lib/assistant.ts`) never adds or changes text in the book. It gets the
  page as Markdown from the page screen, has no tools, and nothing it renders
  writes to the book. ESLint enforces it: assistant modules can't import
  `db`, `db/schema`, the book's data modules (`book*`, `blocks*`,
  `revisions*`), drizzle, the SQL plugin or `invoke`. Keep it that way; the
  page screen hands it what it needs.
- Its actions follow the spec's `assistant.actions`, and its topics
  `book.topics`; `tests/ai-assistant.test.ts` checks both against the spec.
- Conversations live in the panel's state only; they aren't saved.
- Links in model output open in the system browser (`openUrl`), never in the
  app's window.

## Commands

- `bun run dev`: Vite dev server
- `bun run tauri dev`: the app in development. It always runs as
  "My Book Dev" with data of its own, never as the real app:
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
