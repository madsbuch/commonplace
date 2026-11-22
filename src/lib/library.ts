// ---------------------------------------------------------------------------
// The library: papers and books, each a PDF with a few details. The details
// live in `library_items`; the PDF's bytes in `library_files`, kept apart so
// listing the library never reads megabytes. Both sync like the rest of the
// database (LIB-7). The bytes go through Rust commands (src-tauri/src/
// library.rs) as raw IPC bodies: the SQL plugin can only pass JSON values.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { execute, nowIso, select } from "./db";
import { newId } from "./ids";
import { notifyTablesChanged } from "./live";
import { removeItemAuthors } from "./people";

// Spec: LIB-3
/** `library.kinds` in the spec, as stored. */
export const KINDS = ["paper", "book"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_NAMES: Record<Kind, string> = { paper: "Paper", book: "Book" };

export function isKind(x: unknown): x is Kind {
  return KINDS.some((k) => k === x);
}

// Spec: LIB-2
/** `library.max-file-size` in the spec. */
export const MAX_FILE_MB = 100;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

/** A PDF this long or longer is guessed to be a book when added (the author can change it). */
const BOOK_PAGES = 120;

export const LIBRARY_TABLES = ["library_items", "library_files"] as const;

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
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  }));
export type LibraryItem = z.output<typeof ItemSchema>;

const COLUMNS = "id, kind, title, authors, year, filename, file_size, pages, added_at, updated_at";

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

/** Why `file` can't be added, or null. */
export function problemWith(file: File): string | null {
  if (!isPdf(file)) return `${file.name} isn't a PDF.`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than ${MAX_FILE_MB} MB.`;
  return null;
}

/** "Some Paper.pdf" → "Some Paper". */
function fromFilename(name: string): string {
  return name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim() || "Untitled";
}

// Spec: LIB-2, LIB-4
/** Adds a PDF to the library, with the details it carries. Returns the new item's id. */
export async function addFile(file: File): Promise<string> {
  const problem = problemWith(file);
  if (problem) throw new Error(problem);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // pdf.js loads when first needed, and takes over the buffer it's given: hand it a copy.
  const { openPdf, pdfDetails } = await import("./pdf");
  const pdf = await openPdf(bytes.slice());
  const details = await pdfDetails(pdf.doc);
  pdf.close();

  const id = newId("library_items");
  const at = nowIso();
  // The file first: a device that syncs the item before the file shows it as on its way.
  await invoke("library_save_file", bytes, { headers: { "x-item-id": id, "x-media-type": "application/pdf" } });
  await execute(
    `INSERT INTO library_items (id, kind, title, authors, year, filename, file_size, pages, added_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      id,
      details.pages >= BOOK_PAGES ? "book" : "paper",
      details.title ?? fromFilename(file.name),
      details.authors ?? "",
      details.year,
      file.name,
      file.size,
      details.pages,
      at,
    ],
  );
  notifyTablesChanged(LIBRARY_TABLES);
  // The model reads the rest in the background; the item is there meanwhile.
  void import("./libraryDetails").then(({ readDetails }) => readDetails(id, { bytes, metadataAuthors: details.authors }));
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

// Spec: LIB-8
/** Removes an item and its PDF from the library, on every device. */
export async function removeItem(id: string): Promise<void> {
  await removeItemAuthors(id);
  await execute(`DELETE FROM library_files WHERE item_id = $1`, [id]);
  await execute(`DELETE FROM library_items WHERE id = $1`, [id]);
}

// Spec: LIB-6
/** An item's PDF, as stored. */
export async function readFile(id: string): Promise<Uint8Array> {
  const raw: unknown = await invoke("library_read_file", { itemId: id });
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(z.array(z.number()).parse(raw));
  throw new Error("The PDF came back in a form this app doesn't read");
}

/** "2.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
