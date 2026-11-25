import { describe, expect, test } from "bun:test";
import { ago, earlierTexts, foundLine, hnAddressIn, isNew, parseHnId, planThread, threadTree, type StoredComment } from "../src/lib/threadModel";
import { sharedAddress } from "../src/lib/webModel";
import { parseHnThread, type HnItem } from "../src/lib/schemas";

const item = (x: Partial<HnItem> & { id: number }): HnItem => ({ kids: [], ...x });

/** A small thread as the site gives it. */
function site(over: Record<number, Partial<HnItem>> = {}): HnItem[] {
  const base: Record<number, HnItem> = {
    1: item({ id: 1, type: "story", by: "pg", time: 1_700_000_000, title: "Show HN: A thing", url: "https://example.com/thing", score: 42, descendants: 4, kids: [2, 3] }),
    2: item({ id: 2, type: "comment", by: "ada", time: 1_700_000_100, parent: 1, text: "First!", kids: [4] }),
    3: item({ id: 3, type: "comment", by: "bob", time: 1_700_000_200, parent: 1, text: "Second" }),
    4: item({ id: 4, type: "comment", by: "cy", time: 1_700_000_300, parent: 2, text: "A reply" }),
  };
  for (const [k, v] of Object.entries(over)) base[Number(k)] = { ...(base[Number(k)] ?? item({ id: Number(k) })), ...v };
  return Object.values(base);
}

/** Applies a plan's comments over what's kept, as the database would. */
function apply(kept: StoredComment[], changed: StoredComment[]): StoredComment[] {
  const m = new Map(kept.map((c) => [c.id, c]));
  for (const c of changed) m.set(c.id, c);
  return [...m.values()];
}

describe("Hacker News addresses", () => {
  // Spec: LIB-31
  test("an item's address, in any form, names it", () => {
    expect(parseHnId("https://news.ycombinator.com/item?id=42424242")).toBe(42424242);
    expect(parseHnId("news.ycombinator.com/item?id=123&p=2#456")).toBe(123);
    expect(parseHnId("http://news.ycombinator.com/item?id=7")).toBe(7);
    expect(parseHnId("https://news.ycombinator.com/news")).toBeNull();
    expect(parseHnId("https://news.ycombinator.com/item?id=abc")).toBeNull();
    expect(parseHnId("https://example.com/item?id=1")).toBeNull();
    expect(parseHnId("1706.03762")).toBeNull();
  });

  // Spec: LIB-30, LIB-31
  test("shared text with a thread's address adds the thread, not the article beside it", () => {
    expect(hnAddressIn("Look: https://example.com/a and https://news.ycombinator.com/item?id=99.")).toBe("https://news.ycombinator.com/item?id=99");
    expect(sharedAddress("A thing https://example.com/thing https://news.ycombinator.com/item?id=99")).toBe("https://news.ycombinator.com/item?id=99");
    expect(sharedAddress("https://news.ycombinator.com/item?id=99")).toBe("https://news.ycombinator.com/item?id=99");
    expect(sharedAddress("Just https://example.com/thing")).toBe("https://example.com/thing");
  });

  test("what Rust hands back is read forgivingly: items that aren't items are left out", () => {
    const r = parseHnThread({ story: 1, asked: 1, items: [{ id: 1, type: "story", kids: [2] }, "nonsense", { id: "2", text: "hi" }], missing: [], failed: [3] });
    expect(r.items.map((i) => i.id)).toEqual([1, 2]);
    expect(r.items[1]?.kids).toEqual([]);
    expect(r.failed).toEqual([3]);
  });
});

describe("keeping a thread", () => {
  const T0 = "2026-11-25T10:00:00.000Z";
  const T1 = "2026-11-25T12:00:00.000Z";
  const first = planThread({ itemId: "lib_x", fetched: { story: 1, items: site(), missing: [] }, existing: [], texts: [], thread: null, now: T0 });

  // Spec: LIB-31
  test("the story and every comment are kept, under what they answer, in the site's order", () => {
    expect(first.comments.map((c) => c.id).sort()).toEqual(["lib_x.1", "lib_x.2", "lib_x.3", "lib_x.4"]);
    expect(first.added).toBe(3);
    expect(first.thread).toMatchObject({ storyId: "1", url: "https://example.com/thing", siteTitle: "Show HN: A thing", score: 42, commentCount: 4, checkedAt: T0 });
    const tree = threadTree(first.comments, "1");
    expect(tree.story?.author).toBe("pg");
    expect(tree.replies.map((n) => n.comment.sourceId)).toEqual(["2", "3"]);
    expect(tree.replies[0]?.replies[0]?.comment.text).toBe("A reply");
    expect(tree.replies[0]?.under).toBe(1);
    expect(tree.count).toBe(3);
    expect(first.texts).toEqual([]);
  });

  // Spec: LIB-33
  test("fetched again unchanged, nothing is written but the thread's own row", () => {
    const again = planThread({ itemId: "lib_x", fetched: { story: 1, items: site(), missing: [] }, existing: first.comments, texts: [], thread: first.thread, now: T1 });
    expect(again.comments).toEqual([]);
    expect(foundLine(again)).toBe("Nothing new");
    expect(again.thread.checkedAt).toBe(T1);
  });

  // Spec: LIB-33
  test("new comments arrive, marked new for whoever opened it before they did", () => {
    const grown = site({ 3: { kids: [5] }, 5: { id: 5, type: "comment", by: "dee", time: 1_700_000_400, parent: 3, text: "Late" } });
    const plan = planThread({ itemId: "lib_x", fetched: { story: 1, items: grown, missing: [] }, existing: first.comments, texts: [], thread: first.thread, now: T1 });
    expect(plan.added).toBe(1);
    expect(foundLine(plan)).toBe("1 new comment");
    const late = plan.comments.find((c) => c.sourceId === "5");
    expect(late?.firstSeenAt).toBe(T1);
    expect(late && isNew(late, T0)).toBe(true);
    expect(late && isNew(late, null)).toBe(false);
    const old = first.comments.find((c) => c.sourceId === "2");
    expect(old && isNew(old, T0)).toBe(false);
  });

  // Spec: LIB-34
  test("a comment deleted on the site keeps its text here, marked, and its replies stay under it", () => {
    const plan = planThread({
      itemId: "lib_x",
      fetched: { story: 1, items: site({ 2: { deleted: true, text: undefined, by: undefined } }), missing: [] },
      existing: first.comments,
      texts: [],
      thread: first.thread,
      now: T1,
    });
    const c = plan.comments.find((x) => x.sourceId === "2");
    expect(c).toMatchObject({ text: "First!", author: "ada", gone: "deleted", goneAt: T1 });
    expect(foundLine(plan)).toBe("1 gone from the site");
    const tree = threadTree(apply(first.comments, plan.comments), "1");
    expect(tree.replies[0]?.replies[0]?.comment.sourceId).toBe("4");
    // Seen deleted again later, when it went stays.
    const later = planThread({
      itemId: "lib_x",
      fetched: { story: 1, items: site({ 2: { deleted: true, text: undefined, by: undefined } }), missing: [] },
      existing: apply(first.comments, plan.comments),
      texts: [],
      thread: plan.thread,
      now: "2026-11-26T00:00:00.000Z",
    });
    expect(later.comments).toEqual([]);
  });

  // Spec: LIB-34
  test("removed (dead) and missing comments stay too; what the network kept back is left alone", () => {
    const plan = planThread({
      itemId: "lib_x",
      fetched: { story: 1, items: site({ 3: { dead: true } }).filter((i) => i.id !== 4), missing: [4] },
      existing: first.comments,
      texts: [],
      thread: first.thread,
      now: T1,
    });
    expect(plan.comments.find((c) => c.sourceId === "3")).toMatchObject({ gone: "dead", text: "Second" });
    expect(plan.comments.find((c) => c.sourceId === "4")).toMatchObject({ gone: "missing", text: "A reply" });
    // Not fetched at all (the network failed it): untouched.
    const failed = planThread({
      itemId: "lib_x",
      fetched: { story: 1, items: site().filter((i) => i.id !== 4), missing: [] },
      existing: first.comments,
      texts: [],
      thread: first.thread,
      now: T1,
    });
    expect(failed.comments).toEqual([]);
  });

  // Spec: LIB-34
  test("one deleted before it was kept shows only where it has replies", () => {
    const items = site({ 1: { kids: [2, 3, 6, 7] }, 6: { id: 6, parent: 1, deleted: true, kids: [8] }, 7: { id: 7, parent: 1, deleted: true }, 8: { id: 8, parent: 6, text: "Orphaned reply", by: "eve" } });
    const plan = planThread({ itemId: "lib_y", fetched: { story: 1, items, missing: [] }, existing: [], texts: [], thread: null, now: T0 });
    expect(plan.comments.some((c) => c.sourceId === "7")).toBe(false);
    const tree = threadTree(plan.comments, "1");
    const placeholder = tree.replies.find((n) => n.comment.sourceId === "6");
    expect(placeholder?.comment).toMatchObject({ text: null, gone: "deleted" });
    expect(placeholder?.replies[0]?.comment.text).toBe("Orphaned reply");
  });

  // Spec: LIB-35
  test("an edited comment keeps every text seen, the first as first seen", () => {
    const edited = planThread({
      itemId: "lib_x",
      fetched: { story: 1, items: site({ 3: { text: "Second, edited" } }), missing: [] },
      existing: first.comments,
      texts: [],
      thread: first.thread,
      now: T1,
    });
    expect(edited.edited).toBe(1);
    expect(edited.texts).toEqual([
      { commentId: "lib_x.3", text: "Second", seenAt: T0 },
      { commentId: "lib_x.3", text: "Second, edited", seenAt: T1 },
    ]);
    const now = edited.comments.find((c) => c.sourceId === "3");
    expect(now?.text).toBe("Second, edited");
    expect(now && earlierTexts(now, edited.texts).map((t) => t.text)).toEqual(["Second"]);
    // Edited again: the text before is kept already; only the new one is added.
    const kept = apply(first.comments, edited.comments);
    const again = planThread({
      itemId: "lib_x",
      fetched: { story: 1, items: site({ 3: { text: "Second, edited twice" } }), missing: [] },
      existing: kept,
      texts: edited.texts,
      thread: edited.thread,
      now: "2026-11-26T00:00:00.000Z",
    });
    expect(again.texts.map((t) => t.text)).toEqual(["Second, edited twice"]);
    const latest = again.comments.find((c) => c.sourceId === "3");
    expect(latest && earlierTexts(latest, [...edited.texts, ...again.texts]).map((t) => t.text)).toEqual(["Second", "Second, edited"]);
  });

  // Spec: LIB-35
  test("the story's own text keeps its history too", () => {
    const ask = site({ 1: { url: undefined, text: "Ask HN: what?" } });
    const kept = planThread({ itemId: "lib_z", fetched: { story: 1, items: ask, missing: [] }, existing: [], texts: [], thread: null, now: T0 });
    const plan = planThread({
      itemId: "lib_z",
      fetched: { story: 1, items: site({ 1: { url: undefined, text: "Ask HN: what, exactly?" } }), missing: [] },
      existing: kept.comments,
      texts: [],
      thread: kept.thread,
      now: T1,
    });
    expect(plan.texts.map((t) => t.text)).toEqual(["Ask HN: what?", "Ask HN: what, exactly?"]);
  });

  test("the site's order is followed as it changes", () => {
    const plan = planThread({ itemId: "lib_x", fetched: { story: 1, items: site({ 1: { kids: [3, 2] } }), missing: [] }, existing: first.comments, texts: [], thread: first.thread, now: T1 });
    const tree = threadTree(apply(first.comments, plan.comments), "1");
    expect(tree.replies.map((n) => n.comment.sourceId)).toEqual(["3", "2"]);
    expect(plan.edited + plan.added + plan.gone).toBe(0);
  });
});

test("when, in words", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  expect(ago("2026-11-25T11:59:30Z", now)).toBe("just now");
  expect(ago("2026-11-25T11:00:00Z", now)).toBe("1 hour ago");
  expect(ago("2026-11-25T11:55:00Z", now)).toBe("5 minutes ago");
  expect(ago("2026-11-22T12:00:00Z", now)).toBe("3 days ago");
  expect(ago(null, now)).toBe("");
});
