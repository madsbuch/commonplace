import { describe, expect, test } from "bun:test";
import { DETAILS_FORMAT, detailsMessages, parseDetails } from "../src/lib/libraryDetailsModel";

describe("reading a library item's details", () => {
  // Spec: LIB-4
  test("a sloppy answer degrades field by field instead of failing", () => {
    expect(parseDetails({ title: "T", authors: [{ name: "A", institutions: ["U"] }], year: "1936", kind: "paper" })).toEqual({
      title: "T",
      authors: [{ name: "A", institutions: ["U"] }],
      year: 1936,
      kind: "paper",
    });
    const bad = parseDetails({ title: 5, authors: "nobody", year: 99999, kind: "book" });
    expect(bad).toEqual({ title: "", authors: [], year: null, kind: "book" });
  });

  // Spec: LIB-12
  test("the model gets the first pages' text, or images of them", () => {
    const text = detailsMessages({ text: "--- page 1 ---\nOn Computable Numbers" });
    expect(text[1]?.content).toContain("On Computable Numbers");
    const scan = detailsMessages({ images: ["data:image/jpeg;base64,AAAA"] });
    const content = scan[1]?.content;
    expect(Array.isArray(content) && content.some((p) => p.type === "image_url")).toBe(true);
  });

  test("the answer's schema is strict, as structured outputs require", () => {
    const s = DETAILS_FORMAT.schema;
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
  });
});

describe("PDF bytes over the IPC", () => {
  // Spec: LIB-7
  test("base64 decodes back to the same bytes, padding and all", async () => {
    const { bytesOf } = await import("../src/lib/library");
    for (const n of [0, 1, 2, 3, 1000, 300_001]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255);
      expect(bytesOf(Buffer.from(bytes).toString("base64"))).toEqual(bytes);
    }
  });
});
