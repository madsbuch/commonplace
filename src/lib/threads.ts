// ---------------------------------------------------------------------------
// Discussion threads in the library (LIB-31 to LIB-35): a Hacker News thread
// fetched whole by Rust (`hn_thread`, src-tauri/src/hn.rs: only its id goes
// out), kept as `threads`, `thread_comments` and `thread_comment_versions`
// (all synced), and fetched again when it's opened or asked (LIB-33). What
// a fetch changes is decided in threadModel.ts; here it's written, a batch
// of rows to a statement.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { execute, nowIso, select } from "./db";
import { newId } from "./ids";
import { notifyTablesChanged } from "./live";
import { LIBRARY_TABLES } from "./library";
import { parseHnThread } from "./schemas";
import { isGone, parseHnId, planThread, type SeenText, type StoredComment, type StoredThread, type ThreadPlan } from "./threadModel";
import { asWork } from "./work";
import { note } from "./diagnostics";

export const THREAD_TABLES = ["threads", "thread_comments", "thread_comment_versions"] as const;

/** How many rows go in one INSERT. */
const BATCH = 50;

const ThreadRowSchema = z
  .object({
    item_id: z.string(),
    site: z.string(),
    story_id: z.string(),
    url: z.string().nullable(),
    site_title: z.string(),
    score: z.number().nullable(),
    comment_count: z.number().nullable(),
    checked_at: z.string(),
  })
  .transform(
    (r): StoredThread => ({
      itemId: r.item_id,
      site: "hn",
      storyId: r.story_id,
      url: r.url,
      siteTitle: r.site_title,
      score: r.score,
      commentCount: r.comment_count,
      checkedAt: r.checked_at,
    }),
  );

const CommentRowSchema = z
  .object({
    id: z.string(),
    item_id: z.string(),
    source_id: z.string(),
    parent_id: z.string().nullable(),
    rank: z.number(),
    author: z.string().nullable(),
    posted_at: z.string().nullable(),
    text: z.string().nullable(),
    gone: z.string().nullable(),
    gone_at: z.string().nullable(),
    first_seen_at: z.string(),
    updated_at: z.string(),
  })
  .transform(
    (r): StoredComment => ({
      id: r.id,
      itemId: r.item_id,
      sourceId: r.source_id,
      parentId: r.parent_id,
      rank: r.rank,
      author: r.author,
      postedAt: r.posted_at,
      text: r.text,
      gone: isGone(r.gone) ? r.gone : null,
      goneAt: r.gone_at,
      firstSeenAt: r.first_seen_at,
      updatedAt: r.updated_at,
    }),
  );

const TextRowSchema = z
  .object({ comment_id: z.string(), text: z.string(), seen_at: z.string() })
  .transform((r): SeenText => ({ commentId: r.comment_id, text: r.text, seenAt: r.seen_at }));

export async function getThread(itemId: string): Promise<StoredThread | null> {
  return z.array(ThreadRowSchema).parse(await select(`SELECT * FROM threads WHERE item_id = $1`, [itemId]))[0] ?? null;
}

/** A thread's story and comments, and every text they had (LIB-35). */
export async function readThread(itemId: string): Promise<{ thread: StoredThread | null; comments: StoredComment[]; texts: SeenText[] }> {
  const [thread, comments, texts] = await Promise.all([
    getThread(itemId),
    select(`SELECT * FROM thread_comments WHERE item_id = $1`, [itemId]).then((r) => z.array(CommentRowSchema).parse(r)),
    select(`SELECT comment_id, text, seen_at FROM thread_comment_versions WHERE item_id = $1`, [itemId]).then((r) => z.array(TextRowSchema).parse(r)),
  ]);
  return { thread, comments, texts };
}

/** The library item that keeps the thread of `storyId` on `site`, if there is one. */
async function findThread(site: string, storyId: string): Promise<string | null> {
  const [row] = await select(`SELECT t.item_id AS id FROM threads t JOIN library_items i ON i.id = t.item_id WHERE t.site = $1 AND t.story_id = $2 LIMIT 1`, [
    site,
    storyId,
  ]);
  const id = row?.["id"];
  return typeof id === "string" ? id : null;
}

async function sha16(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Writes rows in batches: one INSERT … ON CONFLICT a batch, so a thread of thousands is a few dozen statements. */
async function upsert(table: string, key: string, columns: readonly string[], rows: readonly unknown[][], update: boolean): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const values = batch
      .map((r) => {
        const marks = r.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${marks.join(", ")})`;
      })
      .join(", ");
    const onConflict = update
      ? `ON CONFLICT (${key}) DO UPDATE SET ${columns
          .filter((c) => c !== key)
          .map((c) => `${c} = excluded.${c}`)
          .join(", ")}`
      : `ON CONFLICT (${key}) DO NOTHING`;
    await execute(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ${onConflict}`, params);
  }
}

const COMMENT_COLUMNS = ["id", "item_id", "source_id", "parent_id", "rank", "author", "posted_at", "text", "gone", "gone_at", "first_seen_at", "updated_at"];

/** Writes what a fetch changes: the texts first, then the comments, then the thread's own row. */
async function writePlan(plan: ThreadPlan): Promise<void> {
  const texts = await Promise.all(plan.texts.map(async (t) => [`${t.commentId}.${await sha16(t.text)}`, t.commentId, plan.thread.itemId, t.text, t.seenAt]));
  await upsert("thread_comment_versions", "id", ["id", "comment_id", "item_id", "text", "seen_at"], texts, false);
  await upsert(
    "thread_comments",
    "id",
    COMMENT_COLUMNS,
    plan.comments.map((c) => [c.id, c.itemId, c.sourceId, c.parentId, c.rank, c.author, c.postedAt, c.text, c.gone, c.goneAt, c.firstSeenAt, c.updatedAt]),
    true,
  );
  const t = plan.thread;
  await upsert(
    "threads",
    "item_id",
    ["item_id", "site", "story_id", "url", "site_title", "score", "comment_count", "checked_at"],
    [[t.itemId, t.site, t.storyId, t.url, t.siteTitle, t.score, t.commentCount, t.checkedAt]],
    true,
  );
}

/** The site's thread, fetched whole by Rust. */
async function fetchHn(id: number) {
  const fetched = parseHnThread(await invoke("hn_thread", { id }));
  if (fetched.failed.length > 0) note("warning", "library", `${fetched.failed.length} items of Hacker News thread ${fetched.story} couldn't be fetched; they're left as they were.`);
  return fetched;
}

/** Folds a fetch into the thread kept as `itemId`. */
async function fold(itemId: string, fetched: Awaited<ReturnType<typeof fetchHn>>): Promise<ThreadPlan> {
  const kept = await readThread(itemId);
  const plan = planThread({ itemId, fetched, existing: kept.comments, texts: kept.texts, thread: kept.thread, now: nowIso() });
  await writePlan(plan);
  // The site's title changed, and the author hadn't given it one of their own: it follows.
  if (kept.thread && plan.thread.siteTitle && plan.thread.siteTitle !== kept.thread.siteTitle)
    await execute(`UPDATE library_items SET title = $2, updated_at = $3 WHERE id = $1 AND title = $4`, [itemId, plan.thread.siteTitle, nowIso(), kept.thread.siteTitle]);
  notifyTablesChanged([...THREAD_TABLES, ...LIBRARY_TABLES]);
  return plan;
}

// Spec: LIB-31
/**
 * Adds the Hacker News thread `input` names (its story's address or one of
 * its comments') to the library, or finds it there and brings it up to date.
 * Returns the item and the comment to open at, when a comment was named.
 */
export async function importHnThread(input: string, onStep: (step: string) => void = () => undefined): Promise<{ itemId: string; comment: string | null }> {
  const id = parseHnId(input);
  if (id === null) throw new Error(`"${input.trim()}" isn't a Hacker News address.`);
  // Spec: WORK-1, DIAG-1
  return asWork("library", "Adding a thread from Hacker News", async (work) => {
    onStep("Fetching the thread from Hacker News…");
    const fetched = await fetchHn(id);
    const comment = fetched.asked !== fetched.story ? String(fetched.asked) : null;
    const existing = await findThread("hn", String(fetched.story));
    if (existing) {
      await fold(existing, fetched);
      return { itemId: existing, comment };
    }
    const story = fetched.items.find((i) => i.id === fetched.story);
    const title = story?.title?.trim() || `Hacker News thread ${fetched.story}`;
    work.rename(`Adding “${title}” from Hacker News`);
    onStep(`Keeping ${fetched.items.length - 1} comments…`);
    const itemId = newId("library_items");
    // The comments first: a device that syncs the item before them shows them as on their way.
    await fold(itemId, fetched);
    const at = nowIso();
    const year = story?.time !== undefined ? new Date(story.time * 1000).getUTCFullYear() : null;
    await execute(
      `INSERT INTO library_items (id, kind, title, authors, year, filename, file_size, pages, toc, added_at, updated_at)
       VALUES ($1, 'thread', $2, '', $3, $4, 0, NULL, '[]', $5, $5)`,
      [itemId, title, year, `https://news.ycombinator.com/item?id=${fetched.story}`, at],
    );
    notifyTablesChanged(LIBRARY_TABLES);
    return { itemId, comment };
  });
}

const refreshing = new Map<string, Promise<ThreadPlan>>();

// Spec: LIB-33
/** Fetches the thread again and keeps what's new, edited or gone. One fetch a thread at a time. */
export function refreshThread(itemId: string): Promise<ThreadPlan> {
  const running = refreshing.get(itemId);
  if (running) return running;
  const p = (async () => {
    const thread = await getThread(itemId);
    if (!thread) throw new Error("This thread hasn't fully reached this device yet.");
    return asWork("library", "Looking for new comments on Hacker News", async () => fold(itemId, await fetchHn(Number(thread.storyId))));
  })().finally(() => refreshing.delete(itemId));
  refreshing.set(itemId, p);
  return p;
}
