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
import { fieldsOf } from "./guards";

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
