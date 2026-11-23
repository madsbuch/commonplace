// ---------------------------------------------------------------------------
// Adding a paper from arXiv by its identifier (LIB-23): arXiv's listing for
// the details, its PDF, and its HTML version where arXiv has one (its own,
// or ar5iv's for older papers), figures and all. Only the identifier goes
// out; the HTTP capability allows arXiv's hosts for this.
// ---------------------------------------------------------------------------

import { fetch } from "@tauri-apps/plugin-http";
import { parseArxivFeed, parseArxivId, type ArxivListing } from "./arxivModel";
import { addFile, findByArxiv, getItem, saveHtml } from "./library";
import { notifyTablesChanged } from "./live";

const LISTING = "https://export.arxiv.org/api/query?id_list=";
const PDF = "https://arxiv.org/pdf/";
const HTML_SOURCES = ["https://arxiv.org/html/", "https://ar5iv.labs.arxiv.org/html/"];

async function get(url: string): Promise<{ bytes: Uint8Array; type: string; url: string }> {
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") ?? "", url: r.url || url };
}

export async function arxivListing(id: string): Promise<ArxivListing> {
  const { bytes } = await get(`${LISTING}${encodeURIComponent(id)}`);
  const listing = parseArxivFeed(new TextDecoder().decode(bytes));
  if (!listing) throw new Error(`arXiv doesn't know ${id}.`);
  return listing;
}

// Spec: LIB-24, LIB-27
/** arXiv's HTML version of a paper, self-contained, or null when it has none. */
export async function arxivHtml(id: string): Promise<{ html: string; sourceUrl: string } | null> {
  const { inlineImages, paperOf, sanitizePaper } = await import("./paperHtml");
  for (const source of HTML_SOURCES) {
    let page: { bytes: Uint8Array; url: string };
    try {
      page = await get(`${source}${id}`);
    } catch {
      continue;
    }
    const raw = new TextDecoder().decode(page.bytes);
    // A page about there being no HTML version isn't one.
    if (!raw.includes("ltx_document")) continue;
    const { root } = paperOf(raw);
    // Figures are named from the page's address, as a browser reads them
    // (arXiv's: `2611.21885v2/fig.png` beside `/html/2611.21885`).
    const base = new DOMParser().parseFromString(raw, "text/html").querySelector("base[href]")?.getAttribute("href");
    await inlineImages(root, base ? new URL(base, page.url).toString() : page.url, (url) => get(url));
    return { html: sanitizePaper(root.outerHTML), sourceUrl: page.url };
  }
  return null;
}

// Spec: LIB-23
/**
 * Adds the arXiv paper `input` names (an identifier or an address) to the
 * library, or finds it there already. `onStep` hears how it goes. Returns the item's id.
 */
export async function importArxiv(input: string, onStep: (step: string) => void = () => undefined): Promise<string> {
  const id = parseArxivId(input);
  if (!id) throw new Error(`"${input.trim()}" isn't an arXiv identifier.`);
  const existing = await findByArxiv(id);
  if (existing) return existing;
  onStep("Looking it up on arXiv…");
  const listing = await arxivListing(id);
  onStep("Fetching the PDF…");
  const pdf = await get(`${PDF}${id}`);
  onStep("Fetching the HTML version…");
  const html = await arxivHtml(id).catch(() => null);
  const name = `${id.replace("/", "_")}.pdf`;
  const copy = new Uint8Array(pdf.bytes.length);
  copy.set(pdf.bytes);
  const file = new File([copy], name, { type: "application/pdf" });
  return addFile(file, {
    arxivId: id,
    known: { title: listing.title, authors: listing.authors, year: listing.year },
    ...(html ? { html } : {}),
  });
}

// Spec: LIB-24, LIB-27
/** Fetches an arXiv item's HTML version again (figures and all); false when arXiv has none. */
export async function refetchArxivHtml(itemId: string): Promise<boolean> {
  const item = await getItem(itemId);
  if (!item?.arxivId) return false;
  const html = await arxivHtml(item.arxivId);
  if (!html) return false;
  await saveHtml(itemId, html.html, html.sourceUrl);
  notifyTablesChanged(["library_html"]);
  return true;
}
