// ---------------------------------------------------------------------------
// Reading a library item's details with a model: its first pages' text (or
// images of them, for a scan) go to OpenRouter, and the title, authors with
// their institutions, year and kind come back as JSON. Done when an item is
// added and when the author asks again; otherwise never (LIB-11).
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import { getSetting, setSetting } from "./db";
import { getApiKey } from "./aiSettings";
import { getItem, isKind, LIBRARY_TABLES, readFile, updateItem, type KnownDetails } from "./library";
import { notifyTablesChanged } from "./live";
import { chatJson, errorMessage } from "./openrouter";
import { DETAILS_FORMAT, detailsMessages, parseDetails } from "./libraryDetailsModel";
import { openPdf, type OpenPdf } from "./pdf";
import { itemAuthors, setItemAuthors } from "./people";
import { splitAuthors } from "./peopleModel";
import { DEFAULT_DETAILS_MODEL, DETAILS_MODEL_KEY } from "./settings";

// Spec: LIB-12
/** `library.details-pages` in the spec. */
export const DETAILS_PAGES = 3;
/** Fewer letters than this on the first pages means a scan: send images instead. */
const MIN_TEXT = 200;
/** Enough of the first pages for the title page, the abstract and the author notes. */
const MAX_TEXT = 16_000;
const IMAGE_WIDTH = 1400;

// Spec: LIB-10
export async function getDetailsModel(): Promise<string> {
  return (await getSetting(DETAILS_MODEL_KEY))?.trim() || DEFAULT_DETAILS_MODEL;
}

export async function saveDetailsModel(id: string): Promise<void> {
  await setSetting(DETAILS_MODEL_KEY, id);
}

// ---------------------------------------------------------------------------
// Which items are being read, live (this device only, in memory)
// ---------------------------------------------------------------------------

export type DetailsStatus = { state: "reading" } | { state: "failed"; message: string } | { state: "no-key" };

const statuses = new Map<string, DetailsStatus>();
const listeners = new Set<() => void>();

function setStatus(id: string, s: DetailsStatus | null): void {
  if (s) statuses.set(id, s);
  else statuses.delete(id);
  for (const l of listeners) l();
}

/** Whether `id`'s details are being read, or why reading them failed. */
export function useDetailsStatus(id: string): DetailsStatus | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => statuses.get(id) ?? null,
  );
}

// ---------------------------------------------------------------------------
// What the model sees and answers
// ---------------------------------------------------------------------------

// Spec: LIB-12
/** The text of the first pages, or images of them when they hold no text. */
export async function firstPages(pdf: OpenPdf): Promise<{ text: string } | { images: string[] }> {
  const n = Math.min(DETAILS_PAGES, pdf.doc.numPages);
  const texts: string[] = [];
  for (let i = 1; i <= n; i++) {
    const content = await (await pdf.doc.getPage(i)).getTextContent();
    const line = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("");
    texts.push(`--- page ${i} ---\n${line.trim()}`);
  }
  const text = texts.join("\n\n");
  if (text.replace(/[\s-]|page \d+/g, "").length >= MIN_TEXT) return { text: text.slice(0, MAX_TEXT) };

  const images: string[] = [];
  for (let i = 1; i <= n; i++) {
    const page = await pdf.doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: IMAGE_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    images.push(canvas.toDataURL("image/jpeg", 0.85));
  }
  return { images };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Spec: LIB-9
/** The PDF's own author line as the item's authors, if it has none yet. */
async function fallBack(itemId: string, metadataAuthors: string | null): Promise<void> {
  if (!metadataAuthors || (await itemAuthors(itemId)).length > 0) return;
  await setItemAuthors(
    itemId,
    splitAuthors(metadataAuthors).map((name) => ({ name, institutions: [] })),
  );
}

// Spec: LIB-4, LIB-10, LIB-11, LIB-12
/**
 * Reads an item's details with the model and puts them on the item, its
 * authors and their institutions linked to existing people and institutions.
 * Where no model can be asked, the PDF's own author line is used instead.
 * Returns whether the model's details were applied.
 */
export async function readDetails(
  itemId: string,
  opts: { bytes?: Uint8Array; text?: string; metadataAuthors?: string | null; known?: KnownDetails } = {},
): Promise<boolean> {
  const metadataAuthors = opts.metadataAuthors ?? null;
  const key = await getApiKey();
  if (!key) {
    setStatus(itemId, { state: "no-key" });
    await fallBack(itemId, metadataAuthors);
    notifyTablesChanged(LIBRARY_TABLES);
    return false;
  }
  setStatus(itemId, { state: "reading" });
  try {
    let pages: { text: string } | { images: string[] };
    if (opts.text !== undefined) {
      // Spec: LIB-24
      // An HTML version: its text, as far as the first pages of a PDF would go.
      pages = { text: opts.text.slice(0, MAX_TEXT) };
    } else {
      const bytes = opts.bytes ?? (await readFile(itemId));
      const pdf = await openPdf(bytes.slice());
      try {
        pages = await firstPages(pdf);
      } finally {
        pdf.close();
      }
    }
    const raw = await chatJson(key, await getDetailsModel(), detailsMessages(pages, opts.known), DETAILS_FORMAT, { feature: "library_details" });
    const details = parseDetails(raw);
    if (!(await getItem(itemId))) return false;
    // Spec: LIB-23
    // What arXiv says stands over what the model read.
    const known = opts.known;
    await updateItem(itemId, {
      ...(known ? { title: known.title, year: known.year } : details.title.trim() ? { title: details.title.trim(), year: details.year } : { year: details.year }),
      ...(isKind(details.kind) && !known ? { kind: details.kind } : {}),
    });
    // arXiv's authors stand; the model gives their institutions when it read the same authors.
    const authors = known
      ? known.authors.map((name, i) => ({
          name,
          institutions: (details.authors.length === known.authors.length ? details.authors[i]?.institutions : undefined) ?? [],
        }))
      : details.authors.filter((a) => a.name.trim() !== "");
    if (authors.length > 0) await setItemAuthors(itemId, authors);
    else await fallBack(itemId, metadataAuthors);
    setStatus(itemId, null);
    notifyTablesChanged(["library_items", "people", "institutions", "authorships", "affiliations"]);
    return true;
  } catch (e) {
    setStatus(itemId, { state: "failed", message: errorMessage(e) });
    await fallBack(itemId, metadataAuthors).catch(() => undefined);
    notifyTablesChanged(LIBRARY_TABLES);
    return false;
  }
}
