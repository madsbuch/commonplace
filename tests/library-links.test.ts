import { describe, expect, test } from "bun:test";
import { groupItemLinks, inlineMarkdown, libraryLinksIn, linkingPages } from "../src/lib/bookModel";
import { lastSyncLine, type SyncStatus } from "../src/lib/sync";

const item = (id: string) => ({ type: "libraryLink", props: { itemId: id } });
const text = (t: string) => ({ type: "text", text: t, styles: {} });

describe("links to library items", () => {
  // Spec: LNK-4
  test("are found in a block's content, each once, links included", () => {
    const content = [text("see "), item("lib_a"), text(" and "), item("lib_b"), item("lib_a"), { type: "link", href: "x", content: [item("lib_c")] }];
    expect(libraryLinksIn(content)).toEqual(["lib_a", "lib_b", "lib_c"]);
    expect(libraryLinksIn("not content")).toEqual([]);
  });

  // Spec: LNK-4
  test("read as the item's id for the assistant, or as its title", () => {
    const content = [text("read "), item("lib_a")];
    expect(inlineMarkdown(content, () => "")).toBe("read lib_a");
    expect(inlineMarkdown(content, () => "", (id) => (id === "lib_a" ? "Attention" : "?"))).toBe("read Attention");
  });

  // Spec: LNK-5, LNK-6
  test("are grouped per item, by page title, and name each page once", () => {
    const grouped = groupItemLinks([
      { pageId: "p2", pageTitle: "Mirror life", blockId: "b1", itemIds: ["lib_a", "lib_b"] },
      { pageId: "p1", pageTitle: "Ideas", blockId: "b2", itemIds: ["lib_a"] },
      { pageId: "p2", pageTitle: "Mirror life", blockId: "b3", itemIds: ["lib_a"] },
    ]);
    expect(grouped.get("lib_a")?.map((l) => l.blockId)).toEqual(["b2", "b1", "b3"]);
    expect(grouped.get("lib_b")?.map((l) => l.blockId)).toEqual(["b1"]);
    expect(linkingPages(grouped.get("lib_a") ?? []).map((l) => [l.pageId, l.blockId])).toEqual([["p1", "b2"], ["p2", "b1"]]);
    expect([...groupItemLinks([{ pageId: "p", pageTitle: "P", blockId: "b", itemIds: ["lib_a", "lib_b"] }], "lib_b").keys()]).toEqual(["lib_b"]);
  });
});

describe("the sidebar's sync line", () => {
  const device = (id: string, isSelf: boolean, lastSyncAt: string | null) => ({
    id,
    name: id,
    platform: "linux",
    isSelf,
    lastSyncAt,
    lastCompleteAt: lastSyncAt,
    complete: true,
  });
  const status = (devices: SyncStatus["devices"], inBook = true): SyncStatus => ({
    deviceId: "me",
    name: "me",
    platform: "linux",
    inBook,
    devices,
    canJoin: false,
    held: [],
    offerActive: false,
    syncing: false,
    lastError: null,
    lastRoundAt: null,
  });
  const now = Date.parse("2026-11-26T12:00:00.000Z");

  // Spec: SYN-26
  test("says when this device last synced with any other", () => {
    const s = status([device("me", true, null), device("phone", false, "2026-11-26T11:55:00.000Z"), device("mac", false, "2026-11-26T09:00:00.000Z")]);
    expect(lastSyncLine(s, now)).toBe("Synced 5 min ago");
    expect(lastSyncLine(status([device("me", true, null), device("phone", false, null)]), now)).toBe("Not synced yet");
    expect(lastSyncLine(status([device("me", true, null)]), now)).toBe("Only on this device");
    expect(lastSyncLine(status([], false), now)).toBe("Only on this device");
  });
});
