import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TocEntry } from "../src/lib/schemas";
import {
  beginningEntry,
  chapterAt,
  CHARS_PER_SECOND,
  clock,
  cut,
  isBibliography,
  listenEntries,
  MAX_PASSAGE,
  parseSummary,
  passages,
  pieceId,
  slotAt,
  startOf,
  summaryPrompt,
  timeline,
  timeOfFragment,
  titleWords,
  VOICES,
} from "../src/lib/audioModel";

/** What the script model is told for a verbatim recording: Rust's prompt (src-tauri/src/audio/verbatim.md). */
const VERBATIM_PROMPT = readFileSync(new URL("../src-tauri/src/audio/verbatim.md", import.meta.url), "utf8");

describe("passages for the speech model", () => {
  test("paragraphs stay whole when they fit, and short ones go together", () => {
    expect(cut("One.\n\nTwo.", 100)).toEqual(["One.\n\nTwo."]);
    expect(cut("One.\n\nTwo.", 6)).toEqual(["One.", "Two."]);
  });
  test("long ones are cut at sentences, then words", () => {
    const long = "First sentence here. Second sentence here. Third sentence here.";
    expect(cut(long, 45)).toEqual(["First sentence here. Second sentence here.", "Third sentence here."]);
    expect(cut("a".repeat(5) + " " + "b".repeat(5), 6)).toEqual(["aaaaa", "bbbbb"]);
  });
  test("each paragraph is its own passage, none too long", () => {
    const ps = passages(["Short.", "x ".repeat(1000)]);
    expect(ps[0]).toBe("Short.");
    expect(ps.every((p) => p.length <= MAX_PASSAGE)).toBe(true);
  });
});

// Spec: AUD-3
describe("verbatim recordings", () => {
  test("leave out the bibliography", () => {
    expect(isBibliography("References")).toBe(true);
    expect(isBibliography("7 References")).toBe(true);
    expect(isBibliography("Bibliography")).toBe(true);
    expect(isBibliography("A. References")).toBe(true);
    expect(isBibliography("References to prior work in logic")).toBe(false);
    expect(isBibliography("2.1 Attention")).toBe(false);
  });
});

// Spec: AUD-4
describe("summaries", () => {
  test("ask for the words the length needs", () => {
    expect(summaryPrompt(5)).toContain("About 750 words");
    expect(summaryPrompt(30)).toContain("About 4500 words");
  });
  // Spec: AUD-3, AUD-4
  test("neither a summary nor a reading says who wrote the work", () => {
    expect(summaryPrompt(15)).toContain("never who wrote them");
    expect(VERBATIM_PROMPT).toContain("Drop what isn't read aloud: the authors' names, their institutions");
  });
  test("come back as chapters", () => {
    expect(parseSummary({ title: "Attention", parts: [{ title: "The question", paragraphs: ["Why."] }, { title: "Empty", paragraphs: [] }] })).toEqual({
      title: "Attention",
      chapters: [{ title: "The question", paragraphs: ["Why."] }],
    });
  });
});

describe("the player", () => {
  test("clock times", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.4)).toBe("1:05");
    expect(clock(3729)).toBe("1:02:09");
  });
  test("the chapter playing", () => {
    const chapters = [{ start: 0 }, { start: 10 }, { start: 30 }];
    expect(chapterAt(chapters, 0)).toBe(0);
    expect(chapterAt(chapters, 9.99)).toBe(1);
    expect(chapterAt(chapters, 45)).toBe(2);
  });
  // Spec: AUD-12
  test("the moment in an address", () => {
    expect(timeOfFragment("#t=125.5")).toBe(125.5);
    expect(timeOfFragment("#t=7")).toBe(7);
    expect(timeOfFragment("#page=2")).toBeNull();
  });
  test("thirty voices, each with what it sounds like", () => {
    expect(VOICES.length).toBe(30);
    expect(new Set(VOICES.map((v) => v.name)).size).toBe(30);
  });
});

// Spec: AUD-6, AUD-8
describe("a recording made as it's listened to", () => {
  const script = {
    chapters: [
      { title: "One", chunks: [{ source: "a", passages: ["First passage.", "", "Second."] }, { source: "x".repeat(300), passages: null }] },
      { title: "Two", chunks: [{ source: "c", passages: ["Third."] }] },
    ],
  };

  test("is its passages in order, and its chunks not yet written, each where it starts", () => {
    const tl = timeline("rec", script, new Map([[pieceId("rec", 0, 0, 0), 4]]));
    expect(tl.slots.map((s) => s.id)).toEqual(["rec.0.0.0", "rec.0.0.2", "rec.0.1.0", "rec.1.0.0"]);
    expect(tl.slots.map((s) => s.made)).toEqual([true, false, false, false]);
    expect(tl.slots[2]?.passage).toBeNull();
    // Made: as it is; the rest at the pace of what's made ("First passage." is 14 characters in 4 s).
    expect(tl.slots[1]?.start).toBe(4);
    expect(tl.slots[1]?.seconds).toBeCloseTo(7 / (14 / 4));
    expect(tl.madeSeconds).toBe(4);
    expect(tl.chapters.map((c) => c.title)).toEqual(["One", "Two"]);
    expect(tl.chapters[1]?.start).toBeCloseTo(tl.slots[3]?.start ?? -1);
    expect(tl.duration).toBeCloseTo((tl.slots[3]?.start ?? 0) + (tl.slots[3]?.seconds ?? 0));
  });

  // Spec: AUD-18
  test("each chapter says how much of it is made", () => {
    const none = timeline("rec", script, new Map());
    expect(none.made).toEqual([
      { chapter: 0, key: null, made: 0 },
      { chapter: 1, key: null, made: 0 },
    ]);
    const some = timeline("rec", script, new Map([["rec.0.0.0", 4], ["rec.1.0.0", 1]]));
    expect(some.made[0]?.made).toBeGreaterThan(0);
    expect(some.made[0]?.made).toBeLessThan(1);
    expect(some.made[1]).toEqual({ chapter: 1, key: null, made: 1 });
  });

  test("before any is made, its text gives its length", () => {
    const tl = timeline("rec", script, new Map());
    expect(tl.slots[0]?.seconds).toBeCloseTo(14 / CHARS_PER_SECOND);
    expect(tl.madeSeconds).toBe(0);
  });

  test("a moment is a slot and how far into it; a piece, where it starts", () => {
    const tl = timeline("rec", script, new Map([["rec.0.0.0", 4], ["rec.0.0.2", 2]]));
    expect(slotAt(tl, 0)).toEqual({ index: 0, offset: 0 });
    expect(slotAt(tl, 5)).toEqual({ index: 1, offset: 1 });
    expect(slotAt(tl, 6.5)?.index).toBe(2);
    expect(startOf(tl, "rec.0.0.2")).toBe(4);
    expect(startOf(tl, "rec.9.0.0")).toBeNull();
  });

  test("a recording made before reads as one written chunk a chapter", () => {
    const tl = timeline("old", { chapters: [{ title: "A", paragraphs: ["One.", "Two."] }] }, new Map());
    expect(tl.slots.map((s) => s.id)).toEqual(["old.0.0.0", "old.0.0.1"]);
  });
});

// Spec: AUD-2, AUD-18
describe("listening from an item's contents", () => {
  const entry = (title: string, extra: { anchor?: string; page?: number | null } = {}, children: TocEntry[] = []): TocEntry => ({
    title,
    page: extra.page ?? null,
    ...(extra.anchor ? { anchor: extra.anchor } : {}),
    children,
  });
  const html = [entry("1 Introduction", { anchor: "S1" }), entry("2 Model", { anchor: "S2" }, [entry("2.1 Attention", { anchor: "S2.SS1" })]), entry("References", { anchor: "bib" }, [entry("Further", { anchor: "bib2" })])];

  test("before there's a reading, every section but the bibliography can be listened from", () => {
    expect(listenEntries(html, null, null)).toEqual([
      { key: "html:S1", made: null },
      { key: "html:S2", made: null },
      { key: "html:S2.SS1", made: null },
      null,
      null,
    ]);
    expect(beginningEntry(null, null)).toEqual({ key: "front", made: null });
  });

  test("with a reading, a section is its chapter, by key, with how much of it is made", () => {
    const script = {
      chapters: [
        { title: "Attention", key: "front", chunks: [] },
        { title: "1 Introduction", key: "html:S1", chunks: [] },
        { title: "2 Model", key: "html:S2", chunks: [] },
        { title: "2.1 Attention", key: "html:S2.SS1", chunks: [] },
      ],
    };
    const made = new Map([
      [0, 1],
      [1, 0.5],
    ]);
    expect(listenEntries(html, script, made)).toEqual([{ key: "html:S1", made: 0.5 }, { key: "html:S2", made: 0 }, { key: "html:S2.SS1", made: 0 }, null, null]);
    expect(beginningEntry(script, made)).toEqual({ key: "front", made: 1 });
    expect(beginningEntry({ chapters: [] }, made)).toBeNull();
  });

  test("a PDF's contents beside a reading of the HTML version match by title", () => {
    const pdf = [entry("Introduction", { page: 1 }), entry("2.1. Attention", { page: 3 }), entry("Acknowledgements", { page: 9 })];
    const script = { chapters: [{ title: "1 Introduction", key: "html:S1", chunks: [] }, { title: "2.1 Attention", key: "html:S2.SS1", chunks: [] }] };
    expect(listenEntries(pdf, script, new Map())).toEqual([{ key: "html:S1", made: 0 }, { key: "html:S2.SS1", made: 0 }, null]);
    // A reading of the PDF: its keys count entries with a page.
    expect(listenEntries([entry("Contents"), ...pdf], null, null).map((e) => e?.key ?? null)).toEqual([null, "toc:0", "toc:1", "toc:2"]);
  });

  test("a title's numbering isn't part of it", () => {
    expect(titleWords("2.1 Attention")).toBe("attention");
    expect(titleWords("2.1. Attention")).toBe("attention");
    expect(titleWords("A.1 Proofs")).toBe("proofs");
    expect(titleWords("IV. Results")).toBe("results");
    expect(titleWords("A short note")).toBe("a short note");
    expect(titleWords("Hybrid KV Cache (Global Sharing)")).toBe("hybrid kv cache global sharing");
  });
});
