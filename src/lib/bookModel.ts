// ---------------------------------------------------------------------------
// The book's model, without the database: how rows become a page's tree of
// blocks, what a save has to write, how siblings are ordered, how a page is
// read as it was, and how it reads as Markdown. lib/book.ts does the I/O.
//
// A block in a tree here (`DocBlock`) is in the stored form: the database's
// id and type names, `props` and `content` as JSON values. The editor's own
// form is converted at its edge (src/blocks/).
// ---------------------------------------------------------------------------

import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { parseJson } from "./schemas";

/** A row of `blocks`, as stored. */
export interface BlockRow {
  id: string;
  type: string;
  parentId: string | null;
  position: string;
  props: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** A block in a page's tree, in the stored form. */
export interface DocBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: DocBlock[];
}

/** What a save compares against: a block as last read or written. */
export interface Snapshot {
  type: string;
  parentId: string | null;
  position: string;
  props: string;
  content: string;
}

/** One row a save writes. */
export interface RowWrite extends Snapshot {
  id: string;
  isNew: boolean;
}

export const PAGE_TYPE = "page";

/** JSON with object keys sorted, so equal values always print the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** A stored JSON object, or `{}` when it isn't one. */
export function parseProps(raw: string): Record<string, unknown> {
  try {
    const v = parseJson(raw);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v));
  } catch {
    // Fall through: a corrupt cell reads as no props rather than losing the page.
  }
  return {};
}

/** A stored JSON value, or `[]` when it can't be read. */
export function parseContent(raw: string): unknown {
  try {
    return parseJson(raw);
  } catch {
    return [];
  }
}

/** Siblings in reading order: by position, then id (two devices may pick the same position). */
export function bySiblingOrder(a: { position: string; id: string }, b: { position: string; id: string }): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Live (not deleted) rows grouped by parent, each group in sibling order. */
export function childrenByParent(rows: readonly BlockRow[]): Map<string | null, BlockRow[]> {
  const out = new Map<string | null, BlockRow[]>();
  for (const r of rows) {
    if (r.deletedAt !== null) continue;
    const list = out.get(r.parentId) ?? [];
    list.push(r);
    out.set(r.parentId, list);
  }
  for (const list of out.values()) list.sort(bySiblingOrder);
  return out;
}

// Spec: BOOK-10, PAGE-3
/**
 * A page's content as a tree. A subpage is a leaf here: it is a block of its
 * parent's content, but its own content belongs to it, not to the parent.
 */
export function contentTree(pageId: string, rows: readonly BlockRow[]): DocBlock[] {
  const kids = childrenByParent(rows);
  const build = (parentId: string): DocBlock[] =>
    (kids.get(parentId) ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      props: parseProps(r.props),
      content: parseContent(r.content),
      children: r.type === PAGE_TYPE ? [] : build(r.id),
    }));
  return build(pageId);
}

/** The snapshot of every block in a page's content tree, as `contentTree` read it. */
export function snapshotOf(pageId: string, rows: readonly BlockRow[]): Map<string, Snapshot> {
  const kids = childrenByParent(rows);
  const out = new Map<string, Snapshot>();
  const walk = (parentId: string) => {
    for (const r of kids.get(parentId) ?? []) {
      out.set(r.id, {
        type: r.type,
        parentId: r.parentId,
        position: r.position,
        props: canonical(parseProps(r.props)),
        content: canonical(parseContent(r.content)),
      });
      if (r.type !== PAGE_TYPE) walk(r.id);
    }
  };
  walk(pageId);
  return out;
}

/**
 * Positions for a list of siblings in their new order. Those that already
 * have a position under this parent keep it where the order allows (the
 * longest run of them already in order), so a move writes only the blocks
 * that moved; the rest get fresh keys between their neighbours.
 */
export function assignPositions(existing: readonly (string | null)[]): string[] {
  const n = existing.length;
  // Longest strictly increasing subsequence of the existing positions.
  const keep = new Array<boolean>(n).fill(false);
  const tails: number[] = [];
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = existing[i];
    if (p == null) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = existing[tails[mid] ?? 0];
      if (t != null && t < p) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] ?? -1;
    tails[lo] = i;
  }
  for (let i = tails.length > 0 ? (tails[tails.length - 1] ?? -1) : -1; i >= 0; i = prev[i] ?? -1) keep[i] = true;

  const out = new Array<string>(n);
  let i = 0;
  let lower: string | null = null;
  while (i < n) {
    if (keep[i]) {
      const p = existing[i] ?? null;
      if (p === null) throw new Error("kept a sibling without a position");
      out[i] = p;
      lower = p;
      i++;
      continue;
    }
    let j = i;
    while (j < n && !keep[j]) j++;
    const upper = j < n ? (existing[j] ?? null) : null;
    const keys = generateNKeysBetween(lower, upper, j - i);
    for (let k = i; k < j; k++) out[k] = keys[k - i] ?? generateKeyBetween(lower, upper);
    lower = out[j - 1] ?? lower;
    i = j;
  }
  return out;
}

// Spec: BOOK-11, SYN-14
/**
 * What saving a page's content writes: every block that is new or changed
 * (type, props, content, parent or position), and every block that is gone.
 * Blocks nobody touched are left alone, so a save never overwrites another
 * device's edit to a block this one didn't change.
 *
 * A subpage is shown in its parent's content but owned by itself: from the
 * parent's editor only where it sits is taken, never its title or content.
 */
export function planSave(
  pageId: string,
  before: ReadonlyMap<string, Snapshot>,
  after: readonly DocBlock[],
): { writes: RowWrite[]; removed: string[] } {
  const writes: RowWrite[] = [];
  const seen = new Set<string>();

  const visit = (parentId: string, siblings: readonly DocBlock[]) => {
    const positions = assignPositions(
      siblings.map((b) => {
        const old = before.get(b.id);
        return old && old.parentId === parentId ? old.position : null;
      }),
    );
    siblings.forEach((b, i) => {
      seen.add(b.id);
      const old = before.get(b.id);
      const position = positions[i] ?? generateKeyBetween(null, null);
      const keepOwn = b.type === PAGE_TYPE && old !== undefined;
      const next: Snapshot = {
        type: keepOwn ? old.type : b.type,
        parentId,
        position,
        props: keepOwn ? old.props : canonical(b.props),
        content: keepOwn ? old.content : canonical(b.type === PAGE_TYPE ? [] : b.content),
      };
      if (
        !old ||
        old.type !== next.type ||
        old.parentId !== next.parentId ||
        old.position !== next.position ||
        old.props !== next.props ||
        old.content !== next.content
      ) {
        writes.push({ id: b.id, isNew: !old, ...next });
      }
      if (b.type !== PAGE_TYPE) visit(b.id, b.children);
    });
  };
  visit(pageId, after);

  const removed = [...before.keys()].filter((id) => !seen.has(id));
  return { writes, removed };
}

// ---------------------------------------------------------------------------
// The page tree
// ---------------------------------------------------------------------------

/** What the page tree needs of every live block. */
export interface Skeleton {
  id: string;
  type: string;
  parentId: string | null;
  position: string;
  title: string | null;
}

export interface PageNode {
  id: string;
  title: string;
  /** The page it sits in, or null at the top level. */
  parentPageId: string | null;
  children: PageNode[];
}

export const UNTITLED = "Untitled";

/** A page's title from its props. */
export function titleOf(props: Record<string, unknown>): string {
  const t = props["title"];
  return typeof t === "string" && t.trim() !== "" ? t : UNTITLED;
}

// Spec: PAGE-1, PAGE-2
/**
 * The book's pages as a tree, in reading order. A page sits under the
 * nearest page above it, also when it is nested inside a block of that page.
 * Pages under a deleted block (or a missing one) are not in the book.
 */
export function pageTree(skeleton: readonly Skeleton[]): PageNode[] {
  const kids = new Map<string | null, Skeleton[]>();
  for (const s of skeleton) {
    const list = kids.get(s.parentId) ?? [];
    list.push(s);
    kids.set(s.parentId, list);
  }
  for (const list of kids.values()) list.sort(bySiblingOrder);

  // Every page reached from the top, in document order.
  const build = (parentId: string | null, parentPageId: string | null): PageNode[] => {
    const out: PageNode[] = [];
    for (const s of kids.get(parentId) ?? []) {
      if (s.type === PAGE_TYPE) {
        out.push({ id: s.id, title: s.title ?? UNTITLED, parentPageId, children: build(s.id, s.id) });
      } else if (parentId !== null) {
        out.push(...build(s.id, parentPageId));
      }
    }
    return out;
  };
  return build(null, null);
}

/** Every page in the tree, depth first, with its depth. */
export function flattenTree(nodes: readonly PageNode[], depth = 0): { node: PageNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}

/** Whether `id` is `ancestorId` or lies anywhere beneath it. */
export function isWithin(nodes: readonly PageNode[], ancestorId: string, id: string): boolean {
  const find = (list: readonly PageNode[]): PageNode | null => {
    for (const n of list) {
      if (n.id === ancestorId) return n;
      const f = find(n.children);
      if (f) return f;
    }
    return null;
  };
  const root = find(nodes);
  if (!root) return false;
  const walk = (n: PageNode): boolean => n.id === id || n.children.some(walk);
  return walk(root);
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** A row of `revisions`, as stored. */
export interface RevisionRow {
  id: string;
  blockId: string;
  pageId: string | null;
  type: string;
  parentId: string | null;
  position: string;
  props: string;
  content: string;
  deleted: number;
  createdAt: string;
}

// Spec: BOOK-6
/**
 * A page as it was at `at`: each of its blocks as its latest revision up to
 * then said, if that revision still had it on this page and not deleted.
 * `revisions` are every revision of every block that was ever on the page.
 */
export function pageAt(pageId: string, revisions: readonly RevisionRow[], at: string): { title: string; blocks: DocBlock[] } {
  const latest = new Map<string, RevisionRow>();
  for (const r of revisions) {
    if (r.createdAt > at) continue;
    const cur = latest.get(r.blockId);
    if (!cur || r.createdAt > cur.createdAt || (r.createdAt === cur.createdAt && r.id > cur.id)) latest.set(r.blockId, r);
  }
  const page = latest.get(pageId);
  const rows: BlockRow[] = [];
  for (const r of latest.values()) {
    if (r.blockId === pageId || r.pageId !== pageId) continue;
    rows.push({
      id: r.blockId,
      type: r.type,
      parentId: r.parentId,
      position: r.position,
      props: r.props,
      content: r.content,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
      deletedAt: r.deleted ? r.createdAt : null,
    });
  }
  return { title: page ? titleOf(parseProps(page.props)) : UNTITLED, blocks: contentTree(pageId, rows) };
}

/** The moments a page changed, newest first, to the second. */
export function momentsOf(revisions: readonly RevisionRow[], pageId: string): string[] {
  const set = new Set<string>();
  for (const r of revisions) {
    if (r.pageId === pageId || r.blockId === pageId) set.add(r.createdAt);
  }
  return [...set].sort().reverse();
}

// ---------------------------------------------------------------------------
// Markdown (what the assistant reads)
// ---------------------------------------------------------------------------

type Field = (o: unknown, k: string) => unknown;
const field: Field = (o, k) => (o !== null && typeof o === "object" && k in o ? Object.entries(o).find(([key]) => key === k)?.[1] : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Inline content (the editor's text runs, links, maths, page links) as Markdown. */
export function inlineMarkdown(content: unknown, pageTitle: (id: string) => string): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((run: unknown) => {
      const type = str(field(run, "type"));
      if (type === "text") {
        let t = str(field(run, "text"));
        const styles = field(run, "styles");
        if (field(styles, "code") === true) t = "`" + t + "`";
        if (field(styles, "bold") === true) t = `**${t}**`;
        if (field(styles, "italic") === true) t = `*${t}*`;
        if (field(styles, "strike") === true) t = `~~${t}~~`;
        return t;
      }
      if (type === "link") return `[${inlineMarkdown(field(run, "content"), pageTitle)}](${str(field(run, "href"))})`;
      if (type === "math") return `$${str(field(field(run, "props"), "latex"))}$`;
      if (type === "pageLink") return `[[${pageTitle(str(field(field(run, "props"), "pageId")))}]]`;
      return "";
    })
    .join("");
}

/** A page's content as Markdown. */
export function toMarkdown(blocks: readonly DocBlock[], pageTitle: (id: string) => string, depth = 0): string {
  const indent = "  ".repeat(depth);
  let n = 0;
  const lines: string[] = [];
  for (const b of blocks) {
    const text = inlineMarkdown(b.content, pageTitle);
    if (b.type === "list" && b.props["style"] === "numbered") n++;
    else n = 0;
    switch (b.type) {
      case "heading": {
        const level = typeof b.props["level"] === "number" ? b.props["level"] : 1;
        lines.push(`${indent}${"#".repeat(Math.min(Math.max(level, 1), 6))} ${text}`);
        break;
      }
      case "list":
        lines.push(`${indent}${b.props["style"] === "numbered" ? `${n}.` : "-"} ${text}`);
        break;
      case "code":
        lines.push(`${indent}\`\`\`${str(b.props["language"])}\n${text}\n${indent}\`\`\``);
        break;
      case PAGE_TYPE:
        lines.push(`${indent}[[${pageTitle(b.id)}]]`);
        break;
      case "paragraph":
        lines.push(`${indent}${text}`);
        break;
      default:
        lines.push(`${indent}(a ${b.type} block)`);
    }
    if (b.children.length > 0) {
      const last = lines.pop() ?? "";
      lines.push(`${last}\n${toMarkdown(b.children, pageTitle, depth + 1)}`);
    }
  }
  return lines.join(depth === 0 ? "\n\n" : "\n");
}
