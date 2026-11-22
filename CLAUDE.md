# My Book

An ever-evolving personal book, written in a Tauri app backed by one SQLite database that syncs over the local network. See `.spec/` for what the product is meant to do.

## Spec first

- The spec lives in `.spec/` and follows https://github.com/madsbuch/better-github/blob/main/spec-llms.txt. Read that document before changing the spec.
- A change to what the product does starts as a change to the spec.
- Never delete or renumber requirements, stories, values or items; deprecate with a reason. Meaning changes get a new `version` with `history`.
- Requirement id prefixes: `BOOK-` (book), `AST-` (assistant), `APP-` (desktop app), `STO-` (storage), `SYN-` (sync). Stories use `US-`.
- Code cites the requirements it serves with a comment alone on its line: `// Spec: SYN-1`.
- What isn't decided stays out of the spec. Ask instead.
- Before committing, check that no id is duplicated: `grep -rhoE '"id": *"[^"]+"' .spec | sort | uniq -d` prints nothing.
