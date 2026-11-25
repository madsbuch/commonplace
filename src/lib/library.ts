// ---------------------------------------------------------------------------
// The library: papers, books and blog posts, each a PDF, an HTML version or
// both, with a few details. The details live in `library_items`; the PDF's bytes in
// `library_files` and the HTML in `library_html`, kept apart so listing the
// library never reads megabytes. Both sync like the rest of the
// database (LIB-7). The bytes go through Rust commands (src-tauri/src/
// library.rs) as base64: the SQL plugin can only pass JSON values, and raw
// IPC bodies don't reach Rust on Android.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { execute, nowIso, select } from "./db";
import { newId } from "./ids";
import { parseToc, type TocEntry } from "./schemas";
import { notifyTablesChanged } from "./live";
import { removeItemAuthors } from "./people";

// Spec: LIB-3
/** `library.kinds` in the spec, as stored. */
export const KINDS = ["paper", "book", "post", "thread"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_NAMES: Record<Kind, string> = { paper: "Paper", book: "Book", post: "Blog post", thread: "Thread" };

export function isKind(x: unknown): x is Kind {
  return KINDS.some((k) => k === x);
}

// Spec: LIB-2
/** `library.max-file-size` in the spec. */
export const MAX_FILE_MB = 100;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

/** A PDF this long or longer is guessed to be a book when added (the author can change it). */
const BOOK_PAGES = 120;

export const LIBRARY_TABLES = ["library_items", "library_files", "library_html"] as const;

const ItemSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    authors: z.string(),
    year: z.number().nullable(),
    filename: z.string(),
    file_size: z.number(),
    pages: z.number().nullable(),
    toc: z.string().nullable(),
    arxiv_id: z.string().nullable(),
    added_at: z.string(),
    updated_at: z.string(),
  })
  .transform((r) => ({
    id: r.id,
    kind: isKind(r.kind) ? r.kind : "paper",
    title: r.title,
    authors: r.authors,
    year: r.year,
    filename: r.filename,
    fileSize: r.file_size,
    pages: r.pages,
    /** The table of contents; null until it's been taken from the PDF, `[]` when the PDF has none. */
    toc: parseToc(r.toc),
    arxivId: r.arxiv_id,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  }));
export type LibraryItem = z.output<typeof ItemSchema>;

const COLUMNS = "id, kind, title, authors, year, filename, file_size, pages, toc, arxiv_id, added_at, updated_at";

// Spec: LIB-1
/** Every item, newest first. */
export async function listItems(): Promise<LibraryItem[]> {
  return z.array(ItemSchema).parse(await select(`SELECT ${COLUMNS} FROM library_items ORDER BY added_at DESC`));
}

export async function getItem(id: string): Promise<LibraryItem | null> {
  return z.array(ItemSchema).parse(await select(`SELECT ${COLUMNS} FROM library_items WHERE id = $1`, [id]))[0] ?? null;
}

/** Whether this device has the item's PDF (it may still be on its way from another device). */
export async function hasFile(id: string): Promise<boolean> {
  return (await select(`SELECT 1 AS one FROM library_files WHERE item_id = $1`, [id])).length > 0;
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isHtml(file: File): boolean {
  return file.type === "text/html" || /\.html?$/i.test(file.name);
}

/** Why `file` can't be added, or null. */
export function problemWith(file: File): string | null {
  if (!isPdf(file) && !isHtml(file)) return `${file.name} is neither a PDF nor an HTML file.`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than ${MAX_FILE_MB} MB.`;
  return null;
}

/** "Some Paper.pdf" → "Some Paper". */
function fromFilename(name: string): string {
  return name.replace(/\.(pdf|html?)$/i, "").replace(/[_]+/g, " ").trim() || "Untitled";
}

/** Details known before the model reads anything (arXiv's listing). */
export interface KnownDetails {
  title: string;
  authors: string[];
  year: number | null;
}

/** What comes with a PDF from elsewhere (arXiv). */
export interface Extra {
  known?: KnownDetails;
  arxivId?: string;
  html?: { html: string; sourceUrl: string | null };
}

// Spec: LIB-24
export async function saveHtml(itemId: string, html: string, sourceUrl: string | null): Promise<void> {
  await execute(
    `INSERT INTO library_html (item_id, html, source_url, fetched_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id) DO UPDATE SET html = excluded.html, source_url = excluded.source_url, fetched_at = excluded.fetched_at`,
    [itemId, html, sourceUrl, nowIso()],
  );
}

/** Whether this device has the item's HTML version. */
export async function hasHtml(id: string): Promise<boolean> {
  return (await select(`SELECT 1 AS one FROM library_html WHERE item_id = $1`, [id])).length > 0;
}

/** An item's HTML version, as stored (made safe again where it's shown). */
export async function readHtml(id: string): Promise<string | null> {
  const [row] = await select(`SELECT html FROM library_html WHERE item_id = $1`, [id]);
  const html = row?.["html"];
  return typeof html === "string" ? html : null;
}

// Spec: LIB-23
/** The item that came from arXiv as `arxivId`, if the library has it. */
export async function findByArxiv(arxivId: string): Promise<string | null> {
  const [row] = await select(`SELECT id FROM library_items WHERE arxiv_id = $1`, [arxivId]);
  const id = row?.["id"];
  return typeof id === "string" ? id : null;
}

// Spec: LIB-28
/** The item whose HTML version came from `address`, if the library has it. */
export async function findBySource(address: string): Promise<string | null> {
  const [row] = await select(
    `SELECT i.id AS id FROM library_html h JOIN library_items i ON i.id = h.item_id WHERE h.source_url = $1 LIMIT 1`,
    [address],
  );
  const id = row?.["id"];
  return typeof id === "string" ? id : null;
}

/** A blog post as read from its page (LIB-28). */
export interface Post {
  /** Where it was read, after redirects: kept as its HTML version's source and its file name. */
  address: string;
  title: string;
  authors: string[];
  year: number | null;
  /** Its HTML version, self-contained and safe. */
  html: string;
  toc: TocEntry[];
}

// Spec: LIB-28
/** Adds a blog post as an item of its own, its HTML version as read. Returns its id. */
export async function addPost(post: Post): Promise<string> {
  const id = newId("library_items");
  const at = nowIso();
  // The HTML first: a device that syncs the item before it shows it as on its way.
  await saveHtml(id, post.html, post.address);
  await execute(
    `INSERT INTO library_items (id, kind, title, authors, year, filename, file_size, pages, toc, added_at, updated_at)
     VALUES ($1, 'post', $2, $3, $4, $5, $6, NULL, $7, $8, $8)`,
    [id, post.title, post.authors.join(", "), post.year, post.address, new TextEncoder().encode(post.html).length, JSON.stringify(post.toc), at],
  );
  notifyTablesChanged(LIBRARY_TABLES);
  return id;
}

// Spec: LIB-24
/** Adds an HTML file as an item of its own; its details are read from its text. */
async function addHtmlFile(file: File): Promise<string> {
  const { paperOf, sanitizePaper, sectionsOf, textOf } = await import("./paperHtml");
  const { root, title } = paperOf(await file.text());
  const html = sanitizePaper(root.outerHTML);
  const id = newId("library_items");
  const at = nowIso();
  await saveHtml(id, html, null);
  await execute(
    `INSERT INTO library_items (id, kind, title, authors, year, filename, file_size, pages, toc, added_at, updated_at)
     VALUES ($1, 'paper', $2, '', NULL, $3, $4, NULL, $5, $6, $6)`,
    [id, title ?? fromFilename(file.name), file.name, file.size, JSON.stringify(sectionsOf(root)), at],
  );
  notifyTablesChanged(LIBRARY_TABLES);
  void import("./libraryDetails").then(({ readDetails }) => readDetails(id, { text: textOf(root) }));
  return id;
}

// Spec: LIB-2, LIB-4, LIB-23
/**
 * Adds a PDF (or an HTML file) to the library, with the details it carries,
 * and what came with it from elsewhere. Returns the new item's id.
 */
export async function addFile(file: File, extra: Extra = {}): Promise<string> {
  const problem = problemWith(file);
  if (problem) throw new Error(problem);
  if (isHtml(file)) return addHtmlFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // pdf.js loads when first needed, and takes over the buffer it's given: hand it a copy.
  const { openPdf, pdfDetails, pdfOutline } = await import("./pdf");
  const pdf = await openPdf(bytes.slice());
  const details = await pdfDetails(pdf.doc);
  // Spec: LIB-14
  const toc = await pdfOutline(pdf.doc);
  pdf.close();

  const id = newId("library_items");
  const at = nowIso();
  const known = extra.known;
  // The files first: a device that syncs the item before them shows them as on their way.
  await invoke("library_save_file", { itemId: id, mediaType: "application/pdf", data: await base64Of(file) });
  if (extra.html) await saveHtml(id, extra.html.html, extra.html.sourceUrl);
  await execute(
    `INSERT INTO library_items (id, kind, title, authors, year, filename, file_size, pages, toc, arxiv_id, added_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, $11, $9, $9)`,
    [
      id,
      known ? "paper" : details.pages >= BOOK_PAGES ? "book" : "paper",
      known?.title ?? details.title ?? fromFilename(file.name),
      known ? known.authors.join(", ") : (details.authors ?? ""),
      known ? known.year : details.year,
      file.name,
      file.size,
      details.pages,
      at,
      JSON.stringify(toc),
      extra.arxivId ?? null,
    ],
  );
  notifyTablesChanged(LIBRARY_TABLES);
  // The model reads the rest in the background; the item is there meanwhile.
  const metadataAuthors = known ? known.authors.join(", ") : details.authors;
  void import("./libraryDetails").then(({ readDetails }) => readDetails(id, { bytes, metadataAuthors, ...(known ? { known } : {}) }));
  return id;
}

// Spec: LIB-5
/** Changes an item's details. */
export async function updateItem(id: string, patch: { kind?: Kind; title?: string; authors?: string; year?: number | null }): Promise<void> {
  const item = await getItem(id);
  if (!item) return;
  const next = { ...item, ...patch };
  if (next.kind === item.kind && next.title === item.title && next.authors === item.authors && next.year === item.year) return;
  await execute(`UPDATE library_items SET kind = $2, title = $3, authors = $4, year = $5, updated_at = $6 WHERE id = $1`, [
    id,
    next.kind,
    next.title.trim() || item.title,
    next.authors.trim(),
    next.year,
    nowIso(),
  ]);
}

// Spec: LIB-16
/** Stores a table of contents taken from the item's PDF (for items added before they were taken). */
export async function saveToc(id: string, toc: readonly TocEntry[]): Promise<void> {
  await execute(`UPDATE library_items SET toc = $2 WHERE id = $1 AND toc IS NULL`, [id, JSON.stringify(toc)]);
}

// Spec: LIB-8
/** Removes an item and its PDF (or a thread's comments) from the library, on every device. */
export async function removeItem(id: string): Promise<void> {
  await removeItemAuthors(id);
  await execute(`DELETE FROM library_files WHERE item_id = $1`, [id]);
  await execute(`DELETE FROM library_html WHERE item_id = $1`, [id]);
  // Spec: LIB-31
  await execute(`DELETE FROM thread_comment_versions WHERE item_id = $1`, [id]);
  await execute(`DELETE FROM thread_comments WHERE item_id = $1`, [id]);
  await execute(`DELETE FROM threads WHERE item_id = $1`, [id]);
  await execute(`DELETE FROM library_items WHERE id = $1`, [id]);
}

/** A file's bytes as base64, encoded by the browser rather than in a JS loop. */
function base64Of(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Bytes from base64, a slice at a time so a book-sized PDF doesn't build one huge string. */
export function bytesOf(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, "");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  const CHUNK = 4 * 65_536;
  let at = 0;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const bin = atob(clean.slice(i, i + CHUNK));
    for (let j = 0; j < bin.length; j++) out[at++] = bin.charCodeAt(j);
  }
  return out;
}

// Spec: LIB-6
/** An item's PDF, as stored. */
export async function readFile(id: string): Promise<Uint8Array> {
  const raw: unknown = await invoke("library_read_file", { itemId: id });
  return bytesOf(z.string().parse(raw));
}

/** "2.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
