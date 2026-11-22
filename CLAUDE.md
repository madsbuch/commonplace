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
  `PAR-`/`HEAD-`/`LIST-`/`CODE-` (block types), `LNK-` (links), `AST-`
  (assistant), `AI-` (models and costs), `APP-` (app), `STO-` (storage),
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
- Rust: every crate sets `unsafe_code = "forbid"` in its `Cargo.toml`.

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
- `bun test`: the test suite, including the spec check
- `bun run tauri icon app-icon.png`: regenerate icons from `app-icon.png`

Dependencies install only once published for two weeks (`bunfig.toml`).

## CI

- `check.yml`: `bun test` and `bun run build` on every push.
- `android-apk.yml`, `macos.yml`, `linux.yml`: on push to main, build the
  apps and publish them to the `latest` release.
- Android: `src-tauri/gen/android` isn't committed yet. CI generates it with
  `tauri android init --ci` and adds release signing with
  `scripts/android-signing.mjs`. Once generated locally (needs the Android
  SDK and NDK), commit it and run the script once; CI then uses it as is.
- Release signing for Android reads the secrets `ANDROID_KEYSTORE` (base64),
  `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`; without them the APK
  is unsigned. macOS builds are unsigned.
