// What the author is looking at, kept current for the assistant's
// `look_at_screen` tool: the screen (from the address), and where in it, as
// the screens report it (the block the cursor is in, the PDF page in view).

import type { PdfDocument } from "./pdf";
import { dbId } from "../blocks/ids";

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
  | "ai-settings"
  | "lean-settings"
  | "sync"
  | "costs"
  | "other";

/** What the author has selected, as last seen outside the assistant. */
export interface Selected {
  text: string;
  /** Where: the page editor, a PDF, or anywhere else on screen. */
  in: "editor" | "pdf" | "screen";
  /** In the editor: the blocks the selection touches (row ids). */
  blockIds: string[];
  /** In a PDF: the pages it spans. */
  pdfPages: number[];
}

export interface CurrentView {
  path: string;
  /** The whole address: path, query and fragment. */
  address: string;
  kind: ViewKind;
  /** The page, library item, person, institution or chat on screen. */
  id: string | null;
  /** On a page: the block the cursor is in (its row id). */
  cursorBlockId: string | null;
  /** On a library item: its PDF as open in the viewer, and the page in view. */
  pdf: { itemId: string; page: number; doc: PdfDocument } | null;
  /** On a library item read as text: the section at the top of the view (LIB-26). */
  html: { itemId: string; anchor: string | null } | null;
}

let view: CurrentView = { path: "/", address: "/", kind: "home", id: null, cursorBlockId: null, pdf: null, html: null };
let selected: Selected | null = null;

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
  if (a === "settings" && b === "ai") return { kind: "ai-settings", id: null };
  if (a === "settings" && b === "lean") return { kind: "lean-settings", id: null };
  if (a === "settings" && (b === "sync" || b === "costs")) return { kind: b, id: null };
  if (a === "memory" || a === "settings" || a === "sync" || a === "costs") return { kind: a, id: null };
  return { kind: "other", id: null };
}

/** Called by the layout when the address changes. */
export function setPath(path: string, address = path): void {
  const next = viewOfPath(path);
  const same = next.kind === view.kind && next.id === view.id;
  if (!same) selected = null;
  view = { path, address, ...next, cursorBlockId: same ? view.cursorBlockId : null, pdf: same ? view.pdf : null, html: same ? view.html : null };
}

/** Called when a screen writes where it's scrolled to into the address (lib/address.ts). */
export function setAddress(address: string): void {
  view = { ...view, address };
}

/** Called by the page editor when the cursor moves to another block. */
export function setCursorBlock(id: string | null): void {
  view = { ...view, cursorBlockId: id };
}

// Spec: ATL-10
/** Called by the text reader as sections come into view (null when it closes). */
export function setHtmlInView(html: CurrentView["html"]): void {
  view = { ...view, html };
}

/** Called by the PDF viewer as pages come into view (null when it closes). */
export function setPdfInView(pdf: CurrentView["pdf"]): void {
  view = { ...view, pdf };
}

export function currentView(): CurrentView {
  return view;
}

// Spec: ATL-1, APP-10
/**
 * What each kind of address shows, for the assistant to read the address by.
 * Every screen's address also holds what it shows within it (APP-10): a new
 * screen, or a new kind of state on one, adds it here.
 */
export const ROUTES: readonly { address: string; shows: string }[] = [
  { address: "/", shows: "The book's front page (reopens the last page)." },
  {
    address: "/page/<page id>",
    shows: "A page of the book, in the editor. `#<block id>` is the block at the top of the view: opening it scrolls that block to the top.",
  },
  { address: "/page/<page id>/history", shows: "The page as it was at a chosen moment, `?at=<time>` (the latest without it)." },
  {
    address: "/library",
    shows: "The papers and books; `?tab=people` or `?tab=institutions` lists those instead, `?q=<words>` searches, `?kind=paper` or `?kind=book` filters.",
  },
  {
    address: "/library/<item id>",
    shows:
      "One paper or book: its details, and its PDF in a viewer (`#page=<n>`, the page in view) or, with `?view=text`, its HTML version as text (`#<section id>`, the section in view).",
  },
  { address: "/library/people/<person id>", shows: "A person: what they wrote, where they were, who they wrote with." },
  { address: "/library/institutions/<institution id>", shows: "An institution: its items and people." },
  { address: "/chats", shows: "Every chat with you." },
  { address: "/chats/<chat id>", shows: "One chat, on its own." },
  { address: "/memory", shows: "Your memory." },
  { address: "/settings", shows: "Settings: rows leading to AI and models, Lean, sync, AI costs and memory, and the appearance switch." },
  { address: "/settings/ai", shows: "The OpenRouter key, the assistant's model and the model that reads library details." },
  { address: "/settings/lean", shows: "Whether this computer verifies Lean blocks (Lean with Mathlib), and setting that up." },
  { address: "/settings/sync", shows: "Sync with the author's other devices." },
  { address: "/settings/costs", shows: "What AI has cost; `?range=90d`, `1y` or `all` (the last 30 days without it)." },
  { address: "/sync", shows: "Leads to /settings/sync." },
  { address: "/costs", shows: "Leads to /settings/costs." },
];

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

/** The selection on screen now, or null when there's none (or it's in the assistant's box). */
function readSelection(): Selected | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (text === "") return null;
  const range = sel.getRangeAt(0);
  const where = elementOf(range.commonAncestorContainer);
  if (!where || where.closest(".assistant-input")) return null;
  const editor = where.closest(".bn-editor");
  if (editor) {
    // A block counts when the selection touches its own content, not only its children's.
    const blockIds = [...editor.querySelectorAll('[data-node-type="blockContainer"][data-id]')]
      .filter((el) => {
        const own = el.querySelector(":scope > .bn-block-content");
        return own !== null && range.intersectsNode(own);
      })
      .map((el) => dbId(el.getAttribute("data-id") ?? ""))
      .filter((id) => id !== "");
    return { text, in: "editor", blockIds: [...new Set(blockIds)], pdfPages: [] };
  }
  const pages = [elementOf(range.startContainer), elementOf(range.endContainer)]
    .map((el) => Number(el?.closest(".pdf-page")?.getAttribute("data-page") ?? NaN))
    .filter((n) => Number.isFinite(n));
  if (pages.length > 0) {
    const [from = 1, to = from] = pages;
    const span: number[] = [];
    for (let n = Math.min(from, to); n <= Math.max(from, to); n++) span.push(n);
    return { text, in: "pdf", blockIds: [], pdfPages: span };
  }
  return { text, in: "screen", blockIds: [], pdfPages: [] };
}

// Spec: ATL-6
/**
 * Keeps the author's last selection. Moving to the assistant to ask about it
 * clears the selection on screen, so a selection is only forgotten when the
 * author clears it somewhere else (or goes to another screen).
 */
let tracking = false;
export function installSelectionTracking(): void {
  if (tracking) return;
  tracking = true;
  document.addEventListener("selectionchange", () => {
    const now = readSelection();
    if (now) {
      selected = now;
      return;
    }
    const active = document.activeElement;
    if (active instanceof Element && active.closest(".assistant, .chat-screen")) return;
    selected = null;
  });
}

export function currentSelection(): Selected | null {
  return selected;
}
