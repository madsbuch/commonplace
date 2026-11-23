/**
 * pdf.js, for reading library PDFs and taking their details.
 *
 * The parser runs in a worker bundled by Vite and served from the app's own
 * origin, so the CSP's `'self'` allows it; its fonts, character maps, colour
 * profiles and image decoders are copied into the bundle too (vite.config.ts),
 * since nothing may be fetched from elsewhere at runtime and a phone may be
 * offline. Loaded on first use, not at startup. As in Tally.
 */
// Bundled, not a CDN URL: the worker has to be same-origin under the CSP.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { z } from "zod";
import { fieldsOf } from "./guards";
import type { TocEntry } from "./schemas";

// The legacy build: pdf.js 6 targets browsers newer than the WebView on a
// phone; the legacy bundle ships the polyfills.
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type LoadingTask = ReturnType<PdfJs["getDocument"]>;
export type PdfDocument = Awaited<LoadingTask["promise"]>;

/** An open PDF and how to let go of it (stops its worker work, frees its memory). */
export interface OpenPdf {
  doc: PdfDocument;
  close: () => void;
}

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  });
  return pdfjsPromise;
}

/** Where vite.config.ts serves pdf.js's own resources from. */
const RESOURCES = {
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  cMapUrl: "/pdfjs/cmaps/",
  iccUrl: "/pdfjs/iccs/",
  wasmUrl: "/pdfjs/wasm/",
};

/** Opens a PDF from its bytes. pdf.js takes the buffer over, so pass a copy you don't need. */
export async function openPdf(bytes: Uint8Array): Promise<OpenPdf> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes, ...RESOURCES });
  const doc = await task.promise;
  return { doc, close: () => void task.destroy() };
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export interface PdfDetails {
  title: string | null;
  authors: string | null;
  year: number | null;
  pages: number;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** The year of a PDF date (`D:20210314…`) or an ISO date. */
export function yearOf(raw: unknown): number | null {
  const s = text(raw);
  const m = s ? /^(?:D:)?(\d{4})/.exec(s) : null;
  const y = m ? Number(m[1]) : NaN;
  return y >= 1400 && y <= 2200 ? y : null;
}

/**
 * Titles some producers write instead of the real one: the file name, the
 * word processor's placeholder, or nothing useful.
 */
function plausibleTitle(t: string | null): string | null {
  if (!t) return null;
  if (/^(untitled|microsoft word|document\d*|\S+\.(pdf|docx?|tex|dvi))$/i.test(t) || t.length < 3) return null;
  return t;
}

// Spec: LIB-4
/** A PDF's own title, authors and year, where it has them; and its page count. */
export async function pdfDetails(doc: PdfDocument): Promise<PdfDetails> {
  const { info, metadata } = await doc.getMetadata().catch(() => ({ info: {}, metadata: null }));
  const fields = fieldsOf(info) ?? {};
  const xmp = (key: string): string | null => {
    try {
      return text(metadata?.get(key));
    } catch {
      return null;
    }
  };
  return {
    title: plausibleTitle(xmp("dc:title") ?? text(fields["Title"])),
    authors: xmp("dc:creator") ?? text(fields["Author"]),
    year: yearOf(xmp("xmp:createdate")) ?? yearOf(fields["CreationDate"]),
    pages: doc.numPages,
  };
}

type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
type Viewport = ReturnType<PdfPage["getViewport"]>;

// Spec: LIB-13
/**
 * pdf.js's text layer over a drawn page: the page's text, invisible but
 * selectable, laid over the canvas at `viewport`'s (CSS) scale. Returns how
 * to stop it.
 */
export async function renderTextLayer(page: PdfPage, viewport: Viewport, container: HTMLElement): Promise<() => void> {
  const pdfjs = await loadPdfjs();
  container.replaceChildren();
  container.style.setProperty("--total-scale-factor", String(viewport.scale));
  container.style.setProperty("--scale-round-x", "1px");
  container.style.setProperty("--scale-round-y", "1px");
  const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
  await layer.render().catch(() => undefined);
  return () => layer.cancel();
}

const RefSchema = z.object({ num: z.number(), gen: z.number() });

/** The 1-based page an outline entry's destination points at, or null. */
async function destPage(doc: PdfDocument, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const target: unknown = explicit[0];
    if (typeof target === "number") return target + 1;
    const ref = RefSchema.safeParse(target);
    return ref.success ? (await doc.getPageIndex(ref.data)) + 1 : null;
  } catch {
    return null;
  }
}

/** How deep, and how many entries, an outline is read: some PDFs carry thousands. */
const MAX_TOC_DEPTH = 6;
const MAX_TOC_ENTRIES = 2000;

// Spec: LIB-14
/** The PDF's own outline as a table of contents (empty when it has none). */
export async function pdfOutline(doc: PdfDocument): Promise<TocEntry[]> {
  const outline: unknown = await doc.getOutline().catch(() => null);
  let budget = MAX_TOC_ENTRIES;
  const walk = async (items: unknown, depth: number): Promise<TocEntry[]> => {
    if (!Array.isArray(items) || depth > MAX_TOC_DEPTH) return [];
    const out: TocEntry[] = [];
    for (const item of items) {
      if (budget-- <= 0) break;
      const f = fieldsOf(item);
      if (!f) continue;
      const title = typeof f["title"] === "string" ? f["title"].replace(/\s+/g, " ").trim() : "";
      if (title === "") continue;
      out.push({ title, page: await destPage(doc, f["dest"]), children: await walk(f["items"], depth + 1) });
    }
    return out;
  };
  return walk(outline, 1);
}
