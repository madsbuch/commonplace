# My Book

An ever-evolving book of what I find professionally interesting: type theory, ontologies, epistemology, probabilistic reasoning and programming.

A Tauri desktop app, one SQLite database per instance, synced over the local network, with an assistant that helps me write — while I keep doing the thinking.

The spec is in [`.spec/`](.spec).

## Development

Needs [Bun](https://bun.sh), Rust, and [Tauri's system dependencies](https://tauri.app/start/prerequisites/).

```sh
bun install
bun run tauri dev     # runs as "My Book Dev", with its own data
bun test              # includes the spec check
bun run build         # typecheck, lint, bundle
```

Builds for Android, Linux and macOS are published to the `latest` release on every push to main.
