// ---------------------------------------------------------------------------
// Discussion threads without I/O (LIB-31 to LIB-35): reading a Hacker News
// address, deciding what a fetch changes in what's kept (new comments,
// edits, deletions), and the tree a thread reads as. Tested in
// tests/threads.test.ts; src/lib/threads.ts does the fetching and storing.
// ---------------------------------------------------------------------------

import type { HnItem } from "./schemas";

/** The site a thread is from: Hacker News, for now. */
export type Site = "hn";

// Spec: LIB-31
/**
 * The Hacker News item an address names (`news.ycombinator.com/item?id=…`,
 * with or without its scheme, other parameters or fragment), or null.
 */
export function parseHnId(input: string): number | null {
  const s = input.trim();
  if (s === "" || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "news.ycombinator.com" && host !== "www.news.ycombinator.com") return null;
  if (url.pathname !== "/item") return null;
  const id = url.searchParams.get("id") ?? "";
  return /^\d{1,12}$/.test(id) ? Number(id) : null;
}

// Spec: LIB-30, LIB-31
/** The first Hacker News item address in shared text, or null. */
export function hnAddressIn(text: string): string | null {
  // The id's digits alone: a sentence's full stop after the address isn't part of it.
  const m = /(?:https?:\/\/)?(?:www\.)?news\.ycombinator\.com\/item\?(?:[^\s<>"#]*?&)?id=(\d{1,12})(?!\d)/i.exec(text);
  return m?.[1] ? hnAddress(m[1]) : null;
}

/** The address of item `id` on Hacker News. */
export function hnAddress(id: number | string): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

/** A thread's story or comment, as kept (`thread_comments`). */
export interface StoredComment {
  id: string;
  itemId: string;
  sourceId: string;
  parentId: string | null;
  rank: number;
  author: string | null;
  postedAt: string | null;
  text: string | null;
  gone: Gone | null;
  goneAt: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/** Why the site no longer shows a comment: deleted by its author, removed (dead), or not there at all. */
export type Gone = "deleted" | "dead" | "missing";

export function isGone(x: unknown): x is Gone {
  return x === "deleted" || x === "dead" || x === "missing";
}

/** A text a comment had, as kept (`thread_comment_versions`). */
export interface SeenText {
  commentId: string;
  text: string;
  seenAt: string;
}

/** A thread's own row (`threads`). */
export interface StoredThread {
  itemId: string;
  site: Site;
  storyId: string;
  url: string | null;
  siteTitle: string;
  score: number | null;
  commentCount: number | null;
  checkedAt: string;
}

/** What a fetch of the site changes in what's kept. */
export interface ThreadPlan {
  thread: StoredThread;
  /** Comments new or changed, whole, to be written. */
  comments: StoredComment[];
  /** Texts not kept before (LIB-35). */
  texts: SeenText[];
  /** How many comments arrived, were edited and went from the site. */
  added: number;
  edited: number;
  gone: number;
}

export function commentId(itemId: string, sourceId: number | string): string {
  return `${itemId}.${sourceId}`;
}

const iso = (seconds: number | undefined): string | null => (seconds === undefined || !Number.isFinite(seconds) ? null : new Date(seconds * 1000).toISOString());

function same(a: StoredComment, b: StoredComment): boolean {
  return (
    a.parentId === b.parentId &&
    a.rank === b.rank &&
    a.author === b.author &&
    a.postedAt === b.postedAt &&
    a.text === b.text &&
    a.gone === b.gone &&
    a.goneAt === b.goneAt
  );
}

// Spec: LIB-31, LIB-33, LIB-34, LIB-35
/**
 * What the items fetched from the site change in a thread as kept: every
 * comment the site gave, written where it's new or changed; a deleted or
 * removed one keeps the text it had here (LIB-34); one the site has nothing
 * for any more is marked missing; one the network kept back is left as it
 * is. A text that changes keeps the one before it beside it (LIB-35): both
 * are kept as texts seen, so edits seen on two devices all stay.
 */
export function planThread(args: {
  itemId: string;
  fetched: { story: number; items: readonly HnItem[]; missing: readonly number[] };
  existing: readonly StoredComment[];
  texts: readonly { commentId: string; text: string }[];
  thread: StoredThread | null;
  now: string;
}): ThreadPlan {
  const { itemId, fetched, now } = args;
  const before = new Map(args.existing.map((c) => [c.id, c]));
  const known = new Set(args.texts.map((t) => `${t.commentId}\n${t.text}`));
  const story = fetched.items.find((i) => i.id === fetched.story);
  // Each item's place among its siblings, as its parent lists them.
  const rankOf = new Map<number, number>();
  for (const i of fetched.items) i.kids.forEach((k, at) => rankOf.set(k, at));

  const comments: StoredComment[] = [];
  const texts: SeenText[] = [];
  let added = 0;
  let edited = 0;
  let goneCount = 0;
  const keepText = (id: string, text: string, seenAt: string) => {
    const key = `${id}\n${text}`;
    if (known.has(key)) return;
    known.add(key);
    texts.push({ commentId: id, text, seenAt });
  };

  for (const item of fetched.items) {
    const isStory = item.id === fetched.story;
    const id = commentId(itemId, item.id);
    const old = before.get(id);
    const gone: Gone | null = item.deleted ? "deleted" : item.dead ? "dead" : null;
    // Deleted, the site gives no text: what was seen here stands.
    const text = item.deleted ? (old?.text ?? null) : (item.text ?? old?.text ?? null);
    const next: StoredComment = {
      id,
      itemId,
      sourceId: String(item.id),
      parentId: isStory ? null : item.parent !== undefined ? String(item.parent) : (old?.parentId ?? String(fetched.story)),
      rank: isStory ? 0 : (rankOf.get(item.id) ?? old?.rank ?? 0),
      author: item.by ?? old?.author ?? null,
      postedAt: iso(item.time) ?? old?.postedAt ?? null,
      text,
      gone,
      goneAt: gone === null ? null : old?.gone === gone ? (old.goneAt ?? now) : old?.gone && old.goneAt ? old.goneAt : now,
      firstSeenAt: old?.firstSeenAt ?? now,
      updatedAt: now,
    };
    if (!old) {
      // Deleted before it was ever seen, with nothing under it: nothing to keep.
      if (gone !== null && text === null && item.kids.length === 0) continue;
      added += isStory || gone !== null ? 0 : 1;
      comments.push(next);
      continue;
    }
    if (old.text !== null && text !== null && old.text !== text) {
      // Spec: LIB-35
      // The text it had, as first seen, and the one it has now.
      keepText(id, old.text, old.firstSeenAt);
      keepText(id, text, now);
      edited++;
    }
    if (old.gone === null && gone !== null) goneCount++;
    if (!same(old, next)) comments.push({ ...next, updatedAt: now });
  }

  // Spec: LIB-34
  // What the site has nothing for any more stays, marked missing.
  for (const m of fetched.missing) {
    const old = before.get(commentId(itemId, m));
    if (!old || old.gone !== null) continue;
    goneCount++;
    comments.push({ ...old, gone: "missing", goneAt: now, updatedAt: now });
  }

  const prev = args.thread;
  return {
    thread: {
      itemId,
      site: "hn",
      storyId: String(fetched.story),
      url: story?.url ?? prev?.url ?? null,
      siteTitle: story?.title ?? prev?.siteTitle ?? "",
      score: story?.score ?? prev?.score ?? null,
      commentCount: story?.descendants ?? prev?.commentCount ?? null,
      checkedAt: now,
    },
    comments,
    texts,
    added,
    edited,
    gone: goneCount,
  };
}

/** A comment in the tree a thread reads as, with what answers it. */
export interface ThreadNode {
  comment: StoredComment;
  replies: ThreadNode[];
  /** How many comments are under it, at any depth. */
  under: number;
}

const order = (a: StoredComment, b: StoredComment) =>
  a.rank - b.rank || (a.postedAt ?? "").localeCompare(b.postedAt ?? "") || Number(a.sourceId) - Number(b.sourceId);

// Spec: LIB-32, LIB-34
/**
 * The thread as it reads: its story, and the comments nested under what
 * they answer, each level in the site's order. A comment whose parent isn't
 * kept stands at the top, after the rest. One deleted without text and with
 * nothing under it is left out.
 */
export function threadTree(rows: readonly StoredComment[], storyId: string): { story: StoredComment | null; replies: ThreadNode[]; count: number } {
  const story = rows.find((r) => r.sourceId === storyId) ?? null;
  const bySource = new Map(rows.map((r) => [r.sourceId, r]));
  const children = new Map<string, StoredComment[]>();
  const orphans: StoredComment[] = [];
  for (const r of rows) {
    if (r.sourceId === storyId) continue;
    const parent = r.parentId ?? storyId;
    if (parent !== storyId && !bySource.has(parent)) {
      orphans.push(r);
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(r);
    children.set(parent, list);
  }
  let count = 0;
  const seen = new Set<string>();
  const build = (list: readonly StoredComment[]): ThreadNode[] => {
    const out: ThreadNode[] = [];
    for (const c of [...list].sort(order)) {
      // A cycle can't come from the site, but a row is never shown twice.
      if (seen.has(c.sourceId)) continue;
      seen.add(c.sourceId);
      const replies = build(children.get(c.sourceId) ?? []);
      if (c.text === null && c.gone !== null && replies.length === 0) continue;
      count++;
      out.push({ comment: c, replies, under: replies.reduce((n, r) => n + 1 + r.under, 0) });
    }
    return out;
  };
  const top = build(children.get(storyId) ?? []);
  const rest = build(orphans);
  return { story, replies: [...top, ...rest], count };
}

// Spec: LIB-35
/** A comment's earlier texts, oldest first, without the one it has now. */
export function earlierTexts(comment: StoredComment, texts: readonly SeenText[]): SeenText[] {
  return texts
    .filter((t) => t.commentId === comment.id && t.text !== comment.text)
    .sort((a, b) => a.seenAt.localeCompare(b.seenAt));
}

// Spec: LIB-33
/** Whether a comment arrived since the thread was last opened on this device (never, the first time). */
export function isNew(comment: StoredComment, lastOpened: string | null): boolean {
  return lastOpened !== null && comment.firstSeenAt > lastOpened;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", else the date. */
export function ago(at: string | null, now: number): string {
  if (!at) return "";
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return plural(Math.floor(s / 60), "minute");
  if (s < 86400) return plural(Math.floor(s / 3600), "hour");
  if (s < 30 * 86400) return plural(Math.floor(s / 86400), "day");
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Spec: LIB-33
/** What a fetch found, in a line: "3 new comments, 1 edited". */
export function foundLine(plan: Pick<ThreadPlan, "added" | "edited" | "gone">): string {
  const parts: string[] = [];
  if (plan.added > 0) parts.push(`${plan.added} new comment${plan.added === 1 ? "" : "s"}`);
  if (plan.edited > 0) parts.push(`${plan.edited} edited`);
  if (plan.gone > 0) parts.push(`${plan.gone} gone from the site`);
  return parts.length > 0 ? parts.join(", ") : "Nothing new";
}
