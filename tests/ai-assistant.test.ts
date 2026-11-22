import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ACTION_BUTTONS,
  ASSISTANT_ACTIONS,
  BOOK_TOPICS,
  SYSTEM_PROMPT,
  answeringElsewhereUntil,
  awaitsAnswer,
  compactTranscript,
  systemMessages,
  transcriptToUi,
} from "../src/lib/assistant";
import { TOOLS, PDF_PAGES_PER_READ } from "../src/lib/assistantTools";
import { viewOfPath } from "../src/lib/currentView";
import { splitTypeIds } from "../src/lib/ids";
import { foldToolCalls } from "../src/lib/openrouter";
import { DEFAULT_ASSISTANT_MODEL } from "../src/lib/settings";
import { parseJson, parseTranscript, type TranscriptMessage } from "../src/lib/schemas";

const SPEC = join(import.meta.dir, "..", ".spec");

function specValue(item: string, id: string): unknown {
  const parsed = z
    .object({ values: z.array(z.object({ id: z.string(), value: z.unknown() })).optional() })
    .parse(parseJson(readFileSync(join(SPEC, item), "utf8")));
  return parsed.values?.find((v) => v.id === id)?.value;
}

describe("the assistant follows the spec's named values", () => {
  // Spec: AST-3
  test("its ways of helping are exactly `assistant.actions`", () => {
    const spec = z.array(z.string()).parse(specValue("assistant/index.json", "assistant.actions"));
    expect(ASSISTANT_ACTIONS.map((a) => a.spec)).toEqual(spec);
    expect(ACTION_BUTTONS.length).toBe(spec.length - 1);
  });

  test("its topics are `book.topics`", () => {
    expect([...BOOK_TOPICS]).toEqual(z.array(z.string()).parse(specValue("book/index.json", "book.topics")));
  });

  // Spec: ATL-3
  test("a PDF read is capped at `assistant.pdf-pages-per-read`", () => {
    expect(PDF_PAGES_PER_READ).toBe(z.number().parse(specValue("assistant/tools.json", "assistant.pdf-pages-per-read")));
  });

  test("the default model is a text model id", () => {
    expect(DEFAULT_ASSISTANT_MODEL).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
  });
});

describe("what the model is told", () => {
  // Spec: AST-2, ATL-5, MEM-1
  test("it never writes the book, can't change it, and keeps only its memory", () => {
    expect(SYSTEM_PROMPT).toContain("never write text for the book");
    expect(SYSTEM_PROMPT).toContain("cannot change the book or the library");
    expect(SYSTEM_PROMPT).toContain("look_at_screen");
    const [, memory] = systemMessages("- [memory_1] (preference) Be blunt.");
    expect(memory?.content).toContain("Be blunt.");
  });

  // Spec: ATL-5
  test("no tool but the memory's writes anything", () => {
    const writers = TOOLS.map((t) => t.name).filter((n) => /^(add|create|update|delete|remove|set|write|move|rename|edit|save)/.test(n));
    expect(writers).toEqual(["update_memory"]);
  });
});

const call = (name: string, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: "{}" } });

describe("transcripts", () => {
  const t: TranscriptMessage[] = [
    { role: "user", content: "Ask me questions…", action: "questions" },
    { role: "assistant", content: "Let me look.", tool_calls: [call("look_at_screen")] },
    { role: "tool", tool_call_id: "c1", content: "x".repeat(2000) },
    { role: "assistant", content: "1. Why?" },
    { role: "user", content: "Because." },
  ];

  // Spec: CHAT-6
  test("tool use folds into one activity row between the question and the answer", () => {
    const ui = transcriptToUi(t, (n) => (n === "look_at_screen" ? "the screen" : n));
    expect(ui.map((i) => i.kind)).toEqual(["user", "activity", "message", "user"]);
    expect(ui[0]).toEqual({ kind: "user", text: "Ask me questions…", action: "Ask questions" });
    expect(ui[1]).toEqual({ kind: "activity", tools: ["the screen"], notes: ["Let me look."] });
  });

  // Spec: CHAT-4, CHAT-5
  test("an unanswered last question, and how long another device may be answering it", () => {
    expect(awaitsAnswer(t)).toBe(true);
    expect(awaitsAnswer(t.slice(0, 4))).toBe(false);
    expect(answeringElsewhereUntil("1767225600000.000001")).toBe(1767225600000 + 10 * 60_000);
    expect(answeringElsewhereUntil("nonsense")).toBe(0);
  });

  test("long tool results from earlier turns are shortened", () => {
    const c = compactTranscript(t);
    const tool = c[2];
    expect(tool?.role === "tool" && tool.content.length < 400).toBe(true);
  });

  // Spec: CHAT-1
  test("a stored transcript reads back, and a corrupt one reads as nothing", () => {
    expect(parseTranscript(JSON.stringify(t))).toEqual(t);
    expect(parseTranscript('[{"role":"robot"}]')).toBeNull();
  });

  test("tool calls are assembled from their streamed pieces", () => {
    let calls = foldToolCalls([], { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read_", arguments: '{"page' } }] } }] });
    calls = foldToolCalls(calls, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "page", arguments: '_id":"x"}' } }] } }] });
    expect(calls).toEqual([{ id: "a", type: "function", function: { name: "read_page", arguments: '{"page_id":"x"}' } }]);
  });
});

describe("ids and the screen", () => {
  // Spec: CHAT-7
  test("ids in a message are found, not inside longer words", () => {
    const id = "lib_01h455vb4pex5vsknk084sn02q";
    expect(splitTypeIds(`See ${id}, and blk_01h455vb4pex5vsknk084sn02q.`)).toEqual([
      "See ",
      { id },
      ", and ",
      { id: "blk_01h455vb4pex5vsknk084sn02q" },
      ".",
    ]);
    expect(splitTypeIds(`x${id}`)).toEqual([`x${id}`]);
  });

  // Spec: ATL-1
  test("the address says what's on screen", () => {
    expect(viewOfPath("/page/blk_1")).toEqual({ kind: "page", id: "blk_1" });
    expect(viewOfPath("/page/blk_1/history")).toEqual({ kind: "page-history", id: "blk_1" });
    expect(viewOfPath("/library/lib_1")).toEqual({ kind: "library-item", id: "lib_1" });
    expect(viewOfPath("/library/people/person_1")).toEqual({ kind: "person", id: "person_1" });
    expect(viewOfPath("/library/institutions/institution_1")).toEqual({ kind: "institution", id: "institution_1" });
    expect(viewOfPath("/library?tab=people")).toEqual({ kind: "library", id: null });
    expect(viewOfPath("/")).toEqual({ kind: "home", id: null });
  });
});
