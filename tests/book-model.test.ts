import { describe, expect, test } from "bun:test";
import {
  assignPositions,
  canonical,
  contentTree,
  momentsOf,
  pageAt,
  pageTree,
  planSave,
  snapshotOf,
  toMarkdown,
  type BlockRow,
  type DocBlock,
  type RevisionRow,
} from "../src/lib/bookModel";

const T = "2026-11-22T10:00:00.000Z";

function row(id: string, parentId: string | null, position: string, type = "paragraph", props: object = {}, content: unknown = []): BlockRow {
  return {
    id,
    type,
    parentId,
    position,
    props: JSON.stringify(props),
    content: JSON.stringify(content),
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
  };
}

const text = (t: string) => [{ type: "text", text: t, styles: {} }];

describe("positions", () => {
  test("keeps positions already in order and fills the rest between them", () => {
    const out = assignPositions(["a1", null, "a3", null]);
    expect(out[0]).toBe("a1");
    expect(out[2]).toBe("a3");
    expect(out[1] !== undefined && out[1] > "a1" && out[1] < "a3").toBe(true);
    expect(out[3] !== undefined && out[3] > "a3").toBe(true);
  });

  test("a move rewrites only the block that moved", () => {
    // c moved to the front.
    const out = assignPositions(["a2", "a0", "a1"]);
    expect(out[1]).toBe("a0");
    expect(out[2]).toBe("a1");
    expect(out[0] !== undefined && out[0] < "a0").toBe(true);
  });

  test("an empty list and a list of new blocks", () => {
    expect(assignPositions([])).toEqual([]);
    const out = assignPositions([null, null, null]);
    expect([...out].sort()).toEqual(out);
    expect(new Set(out).size).toBe(3);
  });
});

describe("content tree and saving", () => {
  const rows = [
    row("p", null, "a0", "page", { title: "Types" }),
    row("b1", "p", "a0", "paragraph", {}, text("one")),
    row("b2", "p", "a1", "list", { style: "bulleted" }, text("two")),
    row("b3", "b2", "a0", "paragraph", {}, text("nested")),
    row("sub", "p", "a2", "page", { title: "Sub" }),
    row("s1", "sub", "a0", "paragraph", {}, text("in sub")),
  ];

  // Spec: PAGE-3
  test("a page's tree stops at its subpages", () => {
    const tree = contentTree("p", rows);
    expect(tree.map((b) => b.id)).toEqual(["b1", "b2", "sub"]);
    expect(tree[1]?.children.map((b) => b.id)).toEqual(["b3"]);
    expect(tree[2]?.children).toEqual([]);
  });

  // Spec: BOOK-11
  test("an unchanged page writes nothing; an edit writes only that block", () => {
    const before = snapshotOf("p", rows);
    const tree = contentTree("p", rows);
    expect(planSave("p", before, tree)).toEqual({ writes: [], removed: [] });

    const edited: DocBlock[] = tree.map((b) => (b.id === "b1" ? { ...b, content: text("one!") } : b));
    const plan = planSave("p", before, edited);
    expect(plan.writes.map((w) => w.id)).toEqual(["b1"]);
    expect(plan.writes[0]?.content).toBe(canonical(text("one!")));
  });

  test("a new block, a removed block and a moved block", () => {
    const before = snapshotOf("p", rows);
    const tree = contentTree("p", rows);
    const [b1, b2, sub] = tree;
    if (!b1 || !b2 || !sub) throw new Error("fixture");
    const fresh: DocBlock = { id: "new", type: "paragraph", props: {}, content: text("new"), children: [] };
    // b3 leaves the list; b1 moves to the end; a new block goes first.
    const plan = planSave("p", before, [fresh, { ...b2, children: [] }, sub, b1]);
    expect(plan.removed).toEqual(["b3"]);
    const ids = plan.writes.map((w) => w.id).sort();
    expect(ids).toEqual(["b1", "new"]);
    expect(plan.writes.find((w) => w.id === "new")?.isNew).toBe(true);
  });

  test("a subpage keeps its own title when its parent is saved", () => {
    const before = snapshotOf("p", rows);
    const tree = contentTree("p", rows).map((b) => (b.id === "sub" ? { ...b, props: { title: "stale" } } : b));
    expect(planSave("p", before, tree).writes).toEqual([]);
  });

  // Spec: BOOK-7
  test("Markdown of a page", () => {
    const md = toMarkdown(contentTree("p", rows), (id) => (id === "sub" ? "Sub" : "?"));
    expect(md).toBe("one\n\n- two\n  nested\n\n[[Sub]]");
  });
});

describe("page tree", () => {
  // Spec: PAGE-1, PAGE-2
  test("pages nest under the nearest page, in order; deleted branches drop out", () => {
    const tree = pageTree([
      { id: "b", type: "page", parentId: null, position: "a1", title: "B" },
      { id: "a", type: "page", parentId: null, position: "a0", title: "A" },
      { id: "x", type: "list", parentId: "a", position: "a0", title: null },
      { id: "a1", type: "page", parentId: "x", position: "a0", title: "Inside a list" },
      { id: "a2", type: "page", parentId: "a", position: "a1", title: null },
      { id: "orphan", type: "page", parentId: "gone", position: "a0", title: "Orphan" },
    ]);
    expect(tree.map((n) => n.title)).toEqual(["A", "B"]);
    expect(tree[0]?.children.map((n) => n.title)).toEqual(["Inside a list", "Untitled"]);
    expect(tree[0]?.children[0]?.parentPageId).toBe("a");
  });
});

describe("history", () => {
  const rev = (id: string, blockId: string, pageId: string | null, createdAt: string, content: string, extra: Partial<RevisionRow> = {}): RevisionRow => ({
    id,
    blockId,
    pageId,
    type: "paragraph",
    parentId: pageId,
    position: "a0",
    props: "{}",
    content: JSON.stringify(text(content)),
    deleted: 0,
    createdAt,
    ...extra,
  });

  // Spec: BOOK-6, SYN-14
  test("a page as it was, with blocks that later moved away or were deleted", () => {
    const revs = [
      rev("r0", "p", null, "2026-01-01T00:00:00Z", "", { type: "page", props: JSON.stringify({ title: "Old title" }) }),
      rev("r1", "b1", "p", "2026-01-02T00:00:00Z", "first"),
      rev("r2", "b1", "p", "2026-01-03T00:00:00Z", "second"),
      // The same block edited on another device before they synced: both kept.
      rev("r2b", "b1", "p", "2026-01-03T00:00:01Z", "second elsewhere"),
      rev("r3", "b2", "p", "2026-01-02T00:00:00Z", "moves away"),
      rev("r4", "b2", "q", "2026-01-04T00:00:00Z", "moves away", { parentId: "q" }),
      rev("r5", "b3", "p", "2026-01-02T00:00:00Z", "deleted later", { position: "a1" }),
      rev("r6", "b3", "p", "2026-01-05T00:00:00Z", "deleted later", { position: "a1", deleted: 1 }),
    ];
    const early = pageAt("p", revs, "2026-01-02T12:00:00Z");
    expect(early.title).toBe("Old title");
    expect(early.blocks.map((b) => JSON.stringify(b.content))).toEqual([
      JSON.stringify(text("first")),
      JSON.stringify(text("moves away")),
      JSON.stringify(text("deleted later")),
    ]);
    const late = pageAt("p", revs, "2026-01-06T00:00:00Z");
    expect(late.blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(late.blocks[0]?.content).toEqual(text("second elsewhere"));
    expect(momentsOf(revs, "p")[0]).toBe("2026-01-05T00:00:00Z");
  });
});
