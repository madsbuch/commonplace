// What the author is looking at, kept current for the assistant's
// `look_at_screen` tool: the screen (from the address), and where in it, as
// the screens report it (the block the cursor is in, the PDF page in view).

import type { PdfDocument } from "./pdf";

export type ViewKind =
  | "home"
  | "page"
  | "page-history"
  | "library"
  | "library-item"
  | "person"
  | "institution"
  | "chats"
  | "chat"
  | "memory"
  | "settings"
  | "sync"
  | "costs"
  | "other";

export interface CurrentView {
  path: string;
  kind: ViewKind;
  /** The page, library item, person, institution or chat on screen. */
  id: string | null;
  /** On a page: the block the cursor is in (its row id). */
  cursorBlockId: string | null;
  /** On a library item: its PDF as open in the viewer, and the page in view. */
  pdf: { itemId: string; page: number; doc: PdfDocument } | null;
}

let view: CurrentView = { path: "/", kind: "home", id: null, cursorBlockId: null, pdf: null };

/** The screen an address shows. */
export function viewOfPath(path: string): Pick<CurrentView, "kind" | "id"> {
  const seg = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  const [a, b, c] = seg;
  if (seg.length === 0) return { kind: "home", id: null };
  if (a === "page" && b) return { kind: c === "history" ? "page-history" : "page", id: b };
  if (a === "library" && b === "people" && c) return { kind: "person", id: c };
  if (a === "library" && b === "institutions" && c) return { kind: "institution", id: c };
  if (a === "library" && b) return { kind: "library-item", id: b };
  if (a === "library") return { kind: "library", id: null };
  if (a === "chats" && b) return { kind: "chat", id: b };
  if (a === "chats") return { kind: "chats", id: null };
  if (a === "memory" || a === "settings" || a === "sync" || a === "costs") return { kind: a, id: null };
  return { kind: "other", id: null };
}

/** Called by the layout when the address changes. */
export function setPath(path: string): void {
  const next = viewOfPath(path);
  const same = next.kind === view.kind && next.id === view.id;
  view = { path, ...next, cursorBlockId: same ? view.cursorBlockId : null, pdf: same ? view.pdf : null };
}

/** Called by the page editor when the cursor moves to another block. */
export function setCursorBlock(id: string | null): void {
  view = { ...view, cursorBlockId: id };
}

/** Called by the PDF viewer as pages come into view (null when it closes). */
export function setPdfInView(pdf: CurrentView["pdf"]): void {
  view = { ...view, pdf };
}

export function currentView(): CurrentView {
  return view;
}
