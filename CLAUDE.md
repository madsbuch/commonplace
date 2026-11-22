# My Book

An ever-evolving personal book, written in a Tauri app backed by one SQLite database that syncs over the local network. See `.spec/` for what the product is meant to do.

## Spec first

- The spec lives in `.spec/` and follows https://github.com/madsbuch/better-github/blob/main/spec-llms.txt. Read that document before changing the spec.
- A change to what the product does starts as a change to the spec.
- Never delete or renumber requirements, stories, values or items; deprecate with a reason. Meaning changes get a new `version` with `history`.
- Requirement id prefixes: `BOOK-` (book), `PAGE-` (pages), `BLK-` (blocks), `PAR-`/`HEAD-`/`LIST-`/`CODE-` (block types), `LNK-` (links), `REV-` (revisions), `AST-` (assistant), `APP-` (desktop app), `STO-` (storage), `SYN-` (sync), `TRG-` (sync triggers), `ID-` (row ids). Stories use `US-`. Requirements keep their id when moved, so older prefixes (e.g. `BOOK-5` under revisions) appear outside their home item.
- A new block type is a new item in `.spec/book/blocks/` with its own prefix.
- Code cites the requirements it serves with a comment alone on its line: `// Spec: SYN-1`.
- What isn't decided stays out of the spec. Ask instead.
- Before committing, check that no id is duplicated: `grep -rhoE '"id": *"[^"]+"' .spec | sort | uniq -d` prints nothing.
