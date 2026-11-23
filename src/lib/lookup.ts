// ---------------------------------------------------------------------------
// The book and the library, read-only: everything the assistant may read,
// and nothing that writes (ATL-5). Assistant modules reach the data through
// here only; ESLint keeps them from importing the data modules themselves.
// ---------------------------------------------------------------------------

import { loadBlock, loadPage, loadPageTree, pageMarkdown, pageOfBlock, plainText, searchLinkTargets, type LinkTarget } from "./book";
import { flattenTree, parseContent, parseProps, titleOf } from "./bookModel";
import { getItem, listItems, readFile, readHtml, type LibraryItem } from "./library";
import type { PdfDocument } from "./pdf";
import { institutionView, itemAuthors, personView, type ItemAuthor } from "./people";

export type { LibraryItem, LinkTarget, ItemAuthor };
export { pageMarkdown, searchLinkTargets, getItem, itemAuthors, personView, institutionView };

/** Every page, depth first: id, title, and depth in the tree. */
export async function pageList(): Promise<{ id: string; title: string; depth: number }[]> {
  return flattenTree(await loadPageTree()).map(({ node, depth }) => ({ id: node.id, title: node.title, depth }));
}

/** A page's title, or null when there's no such page. */
export async function pageTitle(id: string): Promise<string | null> {
  const loaded = await loadPage(id);
  return loaded ? loaded.title : null;
}

/** A block: its page and its text (for a page: its title). */
export async function blockInfo(id: string): Promise<{ pageId: string | null; type: string; text: string } | null> {
  const row = await loadBlock(id);
  if (!row || row.deletedAt !== null) return null;
  if (row.type === "page") return { pageId: row.id, type: "page", text: titleOf(parseProps(row.props)) };
  return { pageId: await pageOfBlock(id), type: row.type, text: plainText(parseContent(row.content)) };
}

/** Library items whose title or authors contain `query` (all of them, newest first, when it's empty). */
export async function searchLibrary(query: string): Promise<LibraryItem[]> {
  const q = query.trim().toLowerCase();
  return (await listItems()).filter((i) => q === "" || `${i.title} ${i.authors} ${i.year ?? ""}`.toLowerCase().includes(q));
}

/** The text of pages `from`..`to` (1-based, inclusive) of an open PDF. */
export async function pdfText(doc: PdfDocument, from: number, to: number): Promise<{ page: number; text: string }[]> {
  const out: { page: number; text: string }[] = [];
  for (let n = Math.max(1, from); n <= Math.min(to, doc.numPages); n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    out.push({ page: n, text: content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : " ") : "")).join("").trim() });
  }
  return out;
}

/** The text of pages of a library item's PDF, and how many pages it has. */
export async function itemPdfText(itemId: string, from: number, to: number): Promise<{ pages: number; text: { page: number; text: string }[] }> {
  const { openPdf } = await import("./pdf");
  const pdf = await openPdf(await readFile(itemId));
  try {
    return { pages: pdf.doc.numPages, text: await pdfText(pdf.doc, from, to) };
  } finally {
    pdf.close();
  }
}

// Spec: ATL-10
/** An item's HTML version as a document to read from, or null when it has none. */
async function htmlRoot(itemId: string): Promise<Element | null> {
  const html = await readHtml(itemId);
  if (html === null) return null;
  const { sanitizePaper } = await import("./paperHtml");
  const doc = new DOMParser().parseFromString(sanitizePaper(html), "text/html");
  return doc.body;
}

// Spec: ATL-10
/** An item's HTML sections, in reading order, with their depth: what can be read a section at a time. */
export async function htmlSections(itemId: string): Promise<{ id: string; title: string; depth: number }[] | null> {
  const root = await htmlRoot(itemId);
  if (!root) return null;
  const { sectionsOf } = await import("./paperHtml");
  const out: { id: string; title: string; depth: number }[] = [];
  const walk = (entries: ReturnType<typeof sectionsOf>, depth: number) => {
    for (const e of entries) {
      if (e.anchor) out.push({ id: e.anchor, title: e.title, depth });
      walk(e.children, depth + 1);
    }
  };
  walk(sectionsOf(root), 0);
  return out;
}

// Spec: ATL-10
/** One section of an item's HTML version as text, maths as LaTeX; the start of the paper for `null`. */
export async function htmlSectionText(itemId: string, sectionId: string | null): Promise<{ title: string; text: string } | null> {
  const root = await htmlRoot(itemId);
  if (!root) return null;
  const { textOf } = await import("./paperHtml");
  const el = sectionId === null ? root : root.querySelector(`[id="${CSS.escape(sectionId)}"]`);
  if (!el) return null;
  const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
  return { title: (heading?.textContent ?? "").replace(/\s+/g, " ").trim(), text: textOf(el) };
}
