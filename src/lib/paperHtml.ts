// ---------------------------------------------------------------------------
// HTML versions of papers (LIB-24 to LIB-27): the paper cut out of the page
// arXiv (or ar5iv) serves, or out of an HTML file; made safe to show; its
// figures inlined so it reads offline; its sections as contents; and a
// section's text for the assistant, maths as LaTeX. Uses the browser's DOM.
// ---------------------------------------------------------------------------

import DOMPurify from "dompurify";
import type { TocEntry } from "./schemas";

/** What's never part of a paper as read here. */
const CHROME = "script, style, link, meta, noscript, nav, header, footer, form, button, input, iframe, object, embed, .ltx_page_navbar, .ltx_page_footer, .ltx_page_header";

// Spec: LIB-25
/**
 * LaTeXML's maths, as browsers show it: the TeX in a formula's annotation
 * moves to its `alttext` (what the assistant reads), and the annotation goes,
 * so it never shows as text.
 */
function tidyMath(root: ParentNode): void {
  for (const a of root.querySelectorAll("annotation, annotation-xml")) {
    const math = a.closest("math");
    const tex = a.getAttribute("encoding") === "application/x-tex" ? (a.textContent ?? "").trim() : "";
    if (math && tex && !math.getAttribute("alttext")) math.setAttribute("alttext", tex);
    a.remove();
  }
  for (const s of root.querySelectorAll("semantics")) s.replaceWith(...s.childNodes);
}

/** Headings without an id get one, in order, so contents and addresses can name them. */
function nameHeadings(root: ParentNode): void {
  let n = 0;
  for (const h of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    n++;
    const section = h.parentElement?.tagName === "SECTION" && h.parentElement.firstElementChild === h ? h.parentElement : null;
    if (!(section ?? h).id) (section ?? h).id = `sec-${n}`;
  }
}

/** The paper in a page: its article (LaTeXML's `.ltx_document`), or the body. */
// Spec: LIB-25, LIB-27
/**
 * What LaTeXML leaves that isn't the paper to read: macros it didn't know
 * (`\affillogo`, shown as text), what comes before the title (logo rows of
 * the authors' institutions), the empty affiliation notes in the author
 * block (the item's own authors carry those), and figures that couldn't be
 * kept. SVG figures, which LaTeXML embeds as objects, become images.
 */
export function tidyPaper(root: Element): void {
  for (const o of root.querySelectorAll('object[type="image/svg+xml"][data]')) {
    const img = root.ownerDocument.createElement("img");
    img.setAttribute("src", o.getAttribute("data") ?? "");
    for (const a of ["id", "class", "width", "height"]) {
      const v = o.getAttribute(a);
      if (v !== null) img.setAttribute(a, v);
    }
    img.setAttribute("alt", o.getAttribute("aria-label") ?? "");
    o.replaceWith(img);
  }
  for (const e of root.querySelectorAll(".ltx_ERROR, .ltx_author_notes")) e.remove();
  const title = root.querySelector(":scope > .ltx_title_document");
  if (title) while (title.previousElementSibling) title.previousElementSibling.remove();
  for (const img of root.querySelectorAll("img")) {
    if (!img.getAttribute("src")) img.remove();
  }
}

export function paperOf(raw: string): { root: Element; title: string | null } {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const root = doc.querySelector("article.ltx_document") ?? doc.body;
  tidyPaper(root);
  for (const e of root.querySelectorAll(CHROME)) e.remove();
  tidyMath(root);
  nameHeadings(root);
  const title =
    root.querySelector(".ltx_title_document")?.textContent?.replace(/\s+/g, " ").trim() ||
    doc.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() ||
    root.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ||
    null;
  return { root, title };
}

function dataUrl(bytes: Uint8Array, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    reader.readAsDataURL(new Blob([copy], { type }));
  });
}

// Spec: LIB-27
/**
 * Puts every figure inside the HTML (a few at a time), each fetched from
 * where the page that held it says, as a browser would: against `base`, the
 * page's address. One that won't come is left out.
 */
export async function inlineImages(root: Element, base: string, get: (url: string) => Promise<{ bytes: Uint8Array; type: string }>): Promise<void> {
  const images = [...root.querySelectorAll("img")].filter((img) => !(img.getAttribute("src") ?? "data:").startsWith("data:"));
  const next = () => images.shift();
  const worker = async () => {
    for (let img = next(); img; img = next()) {
      const src = img.getAttribute("src") ?? "";
      img.removeAttribute("srcset");
      try {
        const { bytes, type } = await get(new URL(src, base).toString());
        img.setAttribute("src", await dataUrl(bytes, type || "image/png"));
      } catch {
        img.remove();
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// Spec: LIB-25
/** A stored HTML version as it's read: tidied (versions kept before the tidying improved too), and safe. */
export function readablePaper(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  tidyPaper(doc.body);
  return sanitizePaper(doc.body.innerHTML);
}

// Spec: LIB-24
/** HTML made safe to show: no scripts, handlers, frames or forms; HTML, MathML and SVG kept. */
export function sanitizePaper(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ["alttext", "display"],
    FORBID_TAGS: ["style", "form", "input", "button", "iframe"],
  });
}

/** The section a heading heads (or the heading itself), and its title. */
function headingOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

// Spec: LIB-25
/** A paper's sections as contents: `anchor` is the element's id; nested sections nest. */
export function sectionsOf(root: Element): TocEntry[] {
  const sections = [...root.querySelectorAll("section[id]")].filter((s) => s.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6"));
  if (sections.length > 0) {
    const parentOf = (s: Element): Element | null => {
      let p = s.parentElement?.closest("section[id]") ?? null;
      while (p && !sections.includes(p)) p = p.parentElement?.closest("section[id]") ?? null;
      return p;
    };
    const entryOf = (s: Element): TocEntry => {
      const h = s.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6");
      return { title: h ? headingOf(h) : s.id, page: null, anchor: s.id, children: sections.filter((c) => parentOf(c) === s).map(entryOf) };
    };
    return sections.filter((s) => parentOf(s) === null).map(entryOf);
  }
  // Plain HTML: its headings, by level.
  const out: TocEntry[] = [];
  const stack: { level: number; entry: TocEntry }[] = [];
  for (const h of root.querySelectorAll("h1[id], h2[id], h3[id], h4[id]")) {
    const level = Number(h.tagName.slice(1));
    const entry: TocEntry = { title: headingOf(h), page: null, anchor: h.id, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.entry.children.push(entry);
    else out.push(entry);
    stack.push({ level, entry });
  }
  return out;
}

// Spec: ATL-10
/** An element's text, maths as `$LaTeX$`, a block per line. */
export function textOf(el: Element): string {
  const copy = el.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const m of copy.querySelectorAll("math")) {
    const tex = m.getAttribute("alttext");
    m.replaceWith(tex ? (m.getAttribute("display") === "block" ? `\n$$${tex}$$\n` : `$${tex}$`) : (m.textContent ?? ""));
  }
  for (const b of copy.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, tr, figcaption, br")) b.append("\n");
  return (copy.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}
