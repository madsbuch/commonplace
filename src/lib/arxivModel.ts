// ---------------------------------------------------------------------------
// arXiv without I/O (LIB-23): reading an identifier the author gives, in any
// of the ways people write one, and arXiv's listing of a paper (its API's
// Atom feed). Tested in tests/arxiv.test.ts.
// ---------------------------------------------------------------------------

const NEW_STYLE = /(\d{4}\.\d{4,5})(?:v\d+)?/;
const OLD_STYLE = /([a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/;

// Spec: LIB-23
/**
 * The arXiv identifier in what the author typed, without its version:
 * `1706.03762`, `arXiv:1706.03762v5`, `https://arxiv.org/abs/1706.03762`,
 * `…/pdf/1706.03762v2.pdf`, or an old one such as `hep-th/9901001`.
 */
export function parseArxivId(input: string): string | null {
  const s = input.trim().replace(/^arxiv:\s*/i, "");
  const path = /arxiv\.org\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i.exec(s)?.[1] ?? s;
  const whole = (re: RegExp) => {
    const m = new RegExp(`^${re.source}$`).exec(path);
    return m?.[1] ?? null;
  };
  return whole(NEW_STYLE) ?? whole(OLD_STYLE);
}

export interface ArxivListing {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  summary: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => ENTITIES[n] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1] !== undefined ? decode(m[1]) : null;
}

// Spec: LIB-23
/** The paper in arXiv's Atom feed (`/api/query?id_list=…`), or null when arXiv doesn't know it. */
export function parseArxivFeed(xml: string): ArxivListing | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) return null;
  const idUrl = tag(entry, "id") ?? "";
  // An unknown identifier comes back as an entry describing the error.
  if (idUrl.includes("/api/errors")) return null;
  const id = parseArxivId(idUrl);
  const title = tag(entry, "title");
  if (!id || !title) return null;
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => decode(m[1] ?? "")).filter((n) => n !== "");
  const year = /<published>(\d{4})-/.exec(entry)?.[1];
  return { id, title, authors, year: year ? Number(year) : null, summary: tag(entry, "summary") ?? "" };
}
