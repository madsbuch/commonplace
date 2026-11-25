// ---------------------------------------------------------------------------
// Adding a blog post by its address (LIB-28). Rust fetches the page
// (`web_get`: a plain GET, only the address goes out); Mozilla's Readability
// finds the post in it, without the site's navigation and the like. A page
// that builds itself in the browser (its HTML an empty shell) reads as too
// little, so it's rendered instead (`web_render`: a hidden webview on a
// computer, an off-screen one on Android) and read again. The post becomes
// the item's HTML version, figures inlined, as arXiv's papers do.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { addFile, addPost, bytesOf, findBySource } from "./library";
import { asWork } from "./work";
import { messageOf, note } from "./diagnostics";
import { bylineAuthors, charsetOf, fullerTitle, hostOf, isPage, isPdf, MIN_ARTICLE_TEXT, pdfBehind, pdfName, webAddress, yearOf } from "./webModel";

const FetchedSchema = z.object({ status: z.number(), contentType: z.string(), url: z.string(), data: z.string() });
const RenderedSchema = z.object({ html: z.string(), url: z.string() });

async function webGet(url: string): Promise<{ status: number; type: string; url: string; bytes: Uint8Array }> {
  const r = FetchedSchema.parse(await invoke("web_get", { url }));
  return { status: r.status, type: r.contentType, url: r.url || url, bytes: bytesOf(r.data) };
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = charsetOf(contentType, new TextDecoder("latin1").decode(bytes.slice(0, 2048)));
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** What was read of a page: the post, and what the page gives of itself. */
interface Article {
  root: Element;
  url: string;
  title: string;
  authors: string[];
  year: number | null;
  site: string;
  /** The post's own text. */
  text: string;
  /** The whole page's text (its date and the like are often outside the post), for the model. */
  pageText: string;
}

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

// Spec: LIB-25
/**
 * Maths as the page typeset it, as MathML the reader shows: KaTeX and
 * MathJax keep a MathML copy beside what they draw, and Readability strips
 * the classes that keep the two apart.
 */
function keepMathml(doc: Document): void {
  for (const k of doc.querySelectorAll(".katex")) {
    const math = k.querySelector(".katex-mathml math");
    if (math) k.replaceWith(math);
  }
  for (const c of doc.querySelectorAll("mjx-container")) {
    const math = c.querySelector("math");
    if (math) {
      if (c.getAttribute("display") === "true") math.setAttribute("display", "block");
      c.replaceWith(math);
    }
  }
}

// Spec: LIB-28
/** Videos, sound and embedded players can't be kept: each becomes a link to it, opened in the browser. */
function mediaAsLinks(root: Element): void {
  for (const m of root.querySelectorAll("video, audio, iframe")) {
    const src = m.getAttribute("src") ?? m.querySelector("source[src]")?.getAttribute("src") ?? "";
    let href: string | null = null;
    try {
      const u = new URL(src);
      href = u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
    } catch {
      href = null;
    }
    if (!href) {
      m.remove();
      continue;
    }
    const p = root.ownerDocument.createElement("p");
    const a = root.ownerDocument.createElement("a");
    a.setAttribute("href", href);
    a.textContent = `${m.tagName === "AUDIO" ? "Sound" : "Video"} at ${hostOf(href)}`;
    p.append(a);
    m.replaceWith(p);
  }
  for (const s of root.querySelectorAll("picture > source")) s.remove();
}

// Spec: LIB-28
/** The post in a page's HTML, or null when Readability finds none. */
async function readArticle(html: string, url: string): Promise<Article | null> {
  const [{ Readability }, { paperOf, textOf }] = await Promise.all([import("@mozilla/readability"), import("./paperHtml")]);
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Addresses in it are read against the page's, as a browser would (its own <base> first).
  const own = doc.querySelector("base[href]")?.getAttribute("href");
  let base = url;
  try {
    base = own ? new URL(own, url).toString() : url;
  } catch {
    base = url;
  }
  for (const b of doc.querySelectorAll("base")) b.remove();
  const b = doc.createElement("base");
  b.setAttribute("href", base);
  doc.head.prepend(b);
  for (const e of doc.querySelectorAll("script, style, noscript, template")) e.remove();
  keepMathml(doc);
  const headings = [...doc.querySelectorAll("h1")].map((h) => tidy(h.textContent));
  const pageText = textOf(doc.body);
  const time = doc.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
  const parsed = new Readability(doc, { charThreshold: 200 }).parse();
  if (!parsed?.content) return null;
  // The post alone: no scripts, styles or chrome; headings named for the contents.
  const post = new DOMParser().parseFromString(parsed.content, "text/html");
  mediaAsLinks(post.body);
  const { root } = paperOf(post.body.innerHTML);
  const title = fullerTitle(tidy(parsed.title), headings) || hostOf(url);
  // The title heads it, without an id: it isn't one of its sections.
  const h1 = root.ownerDocument.createElement("h1");
  h1.textContent = title;
  root.prepend(h1);
  return {
    root,
    url,
    title,
    authors: bylineAuthors(parsed.byline),
    year: yearOf(parsed.publishedTime ?? time),
    site: tidy(parsed.siteName) || hostOf(url),
    text: textOf(root),
    pageText,
  };
}

// Spec: LIB-28
/** The page at `url` as it shows once its scripts have run. */
async function rendered(url: string): Promise<{ html: string; url: string }> {
  return RenderedSchema.parse(await invoke("web_render", { url }));
}

// Spec: LIB-28, LIB-29
/**
 * Adds the blog post at the address `input` names to the library, or finds
 * it there already; a PDF there is added as a file. `onStep` hears how it
 * goes. Returns the item's id.
 */
export async function importWebPage(input: string, onStep: (step: string) => void = () => undefined): Promise<string> {
  const typed = webAddress(input);
  if (!typed) throw new Error(`"${input.trim()}" isn't a web address.`);
  // Spec: LIB-29
  // A code host's page for a PDF shows it in a viewer of its own: the file itself is fetched instead.
  const address = pdfBehind(typed) ?? typed;
  const existing = await findBySource(address);
  if (existing) return existing;
  // Spec: WORK-1, DIAG-1
  return asWork("library", `Adding a post from ${hostOf(address)}`, async (work) => {
    onStep(`Fetching ${hostOf(address)}…`);
    let article: Article | null = null;
    let at = address;
    let problem: unknown = null;
    let page: Awaited<ReturnType<typeof webGet>> | null = null;
    try {
      page = await webGet(address);
      at = page.url;
      if (page.status >= 400) throw new Error(`${address} answered ${page.status}.`);
    } catch (e) {
      // A site that turns away plain fetches may still show itself to a browser: rendering is tried below.
      problem = e;
      page = null;
    }
    if (page) {
      // Spec: LIB-29
      // A PDF is added as the file would be.
      if (isPdf(page.type, page.bytes)) {
        onStep("Adding the PDF…");
        const copy = new Uint8Array(page.bytes.length);
        copy.set(page.bytes);
        return addFile(new File([copy], pdfName(page.url), { type: "application/pdf" }));
      }
      if (!isPage(page.type)) throw new Error(`${address} isn't a web page or a PDF (it's ${page.type.split(";")[0] ?? "something else"}).`);
      article = await readArticle(decode(page.bytes, page.type), page.url);
    }
    // A page that builds itself reads as an empty shell: render it and read it again.
    if (!article || article.text.length < MIN_ARTICLE_TEXT) {
      onStep("Opening the page to read it…");
      try {
        const page = await rendered(at);
        const again = await readArticle(page.html, page.url);
        if (again && again.text.length > (article?.text.length ?? 0)) article = again;
      } catch (e) {
        note("warning", "library", `Rendering ${at} failed: ${messageOf(e)}`);
        if (!article) throw new Error(messageOf(problem ?? e));
      }
    }
    if (!article || article.text.trim() === "") throw new Error(problem ? messageOf(problem) : `No post could be read at ${address}.`);
    const already = await findBySource(article.url);
    if (already) return already;
    work.rename(`Adding “${article.title}” from ${article.site}`);
    onStep("Fetching its figures…");
    const { inlineImages, sanitizePaper, sectionsOf } = await import("./paperHtml");
    await inlineImages(article.root, article.url, async (url) => {
      const r = await webGet(url);
      if (r.status >= 400) throw new Error(`${url}: ${r.status}`);
      return { bytes: r.bytes, type: r.type.split(";")[0]?.trim() ?? "" };
    });
    const id = await addPost({
      address: article.url,
      title: article.title,
      authors: article.authors,
      year: article.year,
      html: sanitizePaper(article.root.outerHTML),
      toc: sectionsOf(article.root),
    });
    // The model reads the rest in the background; the item is there meanwhile. It gets the post,
    // then the top of the page around it, where a date or a byline often stands outside the post.
    const post = { title: article.title, authors: article.authors, year: article.year, site: article.site };
    const text = `${article.text.slice(0, 12_000)}\n\n--- the page around the post ---\n${article.pageText.slice(0, 4_000)}`;
    const metadataAuthors = article.authors.join(", ") || null;
    void import("./libraryDetails").then(({ readDetails }) => readDetails(id, { text, metadataAuthors, post }));
    return id;
  });
}
