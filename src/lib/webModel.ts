// ---------------------------------------------------------------------------
// Blog posts without I/O (LIB-28): reading the address the author gives,
// the page's character set, and the details a page gives of itself (its
// byline, its date, its fuller title). Tested in tests/web.test.ts.
// ---------------------------------------------------------------------------

import { parseArxivId } from "./arxivModel";
import { splitAuthors } from "./peopleModel";

// Spec: LIB-28
/** Less text than this in what was read means the page builds itself in the browser: it's rendered instead. */
export const MIN_ARTICLE_TEXT = 500;

// Spec: LIB-28
/**
 * The web address in what the author typed, without its fragment: an
 * http(s) address, or one without its scheme (`z.ai/blog/glm-5.4`). Null
 * for anything else.
 */
export function webAddress(input: string): string | null {
  const s = input.trim();
  if (s === "" || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /^[^/]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(s) ? `https://${s}` : null;
  if (!withScheme) return null;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname.includes(".")) return null;
  url.hash = "";
  return url.toString();
}

// Spec: LIB-30
/**
 * What a share's text adds: the text itself when it's an arXiv number or a
 * web address, else the first web address in it ("Title — https://…",
 * "Read this: https://…."). A sentence's punctuation after an address isn't
 * part of it; a closing bracket is only when it closes one inside it.
 * Null when it holds neither.
 */
export function sharedAddress(text: string): string | null {
  const s = text.trim();
  if (parseArxivId(s)) return s;
  const whole = webAddress(s);
  if (whole) return whole;
  for (const m of s.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    let candidate = m[0];
    const unclosed = () => candidate.endsWith(")") && candidate.split("(").length < candidate.split(")").length;
    while (/[.,;:!?'’”\]}>*]$/.test(candidate) || unclosed()) candidate = candidate.slice(0, -1);
    const address = webAddress(candidate);
    if (address) return address;
  }
  return null;
}

/** "https://www.example.com/a" → "example.com". */
export function hostOf(address: string): string {
  try {
    return new URL(address).hostname.replace(/^www\./, "");
  } catch {
    return address;
  }
}

/** The character set a page is in: its Content-Type's, else its own `<meta>`'s, else UTF-8. */
export function charsetOf(contentType: string, head: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  return fromMeta?.toLowerCase() ?? "utf-8";
}

/** Whether a response is an HTML page (or says nothing about what it is). */
export function isPage(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "" || type === "text/html" || type === "application/xhtml+xml" || type === "text/plain";
}

// Spec: LIB-29
/** Whether a response is a PDF: as it says, or as its first bytes show (some servers call it anything). */
export function isPdf(contentType: string, bytes: Uint8Array): boolean {
  if ((contentType.split(";")[0]?.trim().toLowerCase() ?? "") === "application/pdf") return true;
  return new TextDecoder("latin1").decode(bytes.slice(0, 1024)).includes("%PDF-");
}

// Spec: LIB-29
/**
 * The PDF file itself behind a page that only shows it, as code hosts show
 * a file they hold: GitHub's `/blob/` (and Bitbucket's `/src/`), GitLab's
 * `/-/blob/`, Gitea's and Forgejo's `/src/branch|tag|commit/` give way to
 * their `raw` counterparts. Null for any other address.
 */
export function pdfBehind(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  if (!/\.pdf$/i.test(path)) return null;
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const raw = (pathname: string) => {
    const out = new URL(url.toString());
    out.pathname = pathname;
    out.search = "";
    out.hash = "";
    return out.toString();
  };
  const p = url.pathname;
  // GitLab, on any host: /<group>/<project>/-/blob/<ref>/<path>.
  if (/\/-\/blob\//.test(p)) return raw(p.replace("/-/blob/", "/-/raw/"));
  // GitHub: /<owner>/<repo>/blob/<ref>/<path>.
  if (host === "github.com") {
    const m = /^(\/[^/]+\/[^/]+)\/blob\/(.+)$/.exec(p);
    return m ? raw(`${m[1] ?? ""}/raw/${m[2] ?? ""}`) : null;
  }
  // Bitbucket: /<owner>/<repo>/src/<ref>/<path>.
  if (host === "bitbucket.org") {
    const m = /^(\/[^/]+\/[^/]+)\/src\/(.+)$/.exec(p);
    return m ? raw(`${m[1] ?? ""}/raw/${m[2] ?? ""}`) : null;
  }
  // Gitea and Forgejo (Codeberg among them): /<owner>/<repo>/src/branch|tag|commit/<ref>/<path>.
  const m = /^(\/[^/]+\/[^/]+)\/src\/((?:branch|tag|commit)\/.+)$/.exec(p);
  return m ? raw(`${m[1] ?? ""}/raw/${m[2] ?? ""}`) : null;
}

/** The file name a PDF at `address` goes by: its last part, else its site's name. */
export function pdfName(address: string): string {
  let last = "";
  try {
    const parts = new URL(address).pathname.split("/").filter((p) => p !== "");
    last = decodeURIComponent(parts[parts.length - 1] ?? "");
  } catch {
    last = "";
  }
  const name = last.replace(/[\\/:*?"<>|]+/g, " ").trim() || hostOf(address);
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

// Spec: LIB-28
/**
 * The people a byline names: "By Ada Lovelace and Charles Babbage" →
 * both; nothing when it reads like something else (a date, a long sentence,
 * an address).
 */
export function bylineAuthors(byline: string | null | undefined): string[] {
  const s = (byline ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:written|posted|published)\s+)?by[:\s]+/i, "");
  if (s === "" || s.length > 160 || /https?:|@|\d{4}/.test(s)) return [];
  const names = splitAuthors(s);
  return names.every((n) => n.split(" ").length <= 5) ? names : [];
}

/** The year in a date as pages give one (`2024-03-01T…`, `March 1, 2024`), or null. */
export function yearOf(date: string | null | undefined): number | null {
  const m = /\b(1[89]\d{2}|2[01]\d{2})\b/.exec(date ?? "");
  return m?.[1] ? Number(m[1]) : null;
}

const plain = (s: string) => s.replace(/\s+/g, " ").trim();

// Spec: LIB-28
/**
 * The title a page gives in its metadata is often the short one; a heading
 * on the page that holds it is the whole title ("GLM-5.4: Toward …" over
 * "Toward …").
 */
export function fullerTitle(title: string, headings: readonly string[]): string {
  const t = plain(title);
  if (t === "") return plain(headings[0] ?? "");
  const fuller = headings.map(plain).find((h) => h.length > t.length && h.length <= t.length * 3 && h.toLowerCase().includes(t.toLowerCase()));
  return fuller ?? t;
}
