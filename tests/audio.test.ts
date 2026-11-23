import { describe, expect, test } from "bun:test";
import { chapterAt, clock, cut, isBibliography, MAX_PASSAGE, parseSpoken, parseSummary, passages, summaryPrompt, timeOfFragment, VERBATIM_PROMPT, VOICES } from "../src/lib/audioModel";

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
  test("read the model's paragraphs, dropping empty ones", () => {
    expect(parseSpoken({ paragraphs: [" x squared. ", "", "Next."] })).toEqual(["x squared.", "Next."]);
    expect(parseSpoken("nonsense")).toEqual([]);
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
