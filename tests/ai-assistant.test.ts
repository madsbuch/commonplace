import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ASSISTANT_ACTIONS, BOOK_TOPICS, SYSTEM_PROMPT, actionTurn, buildMessages } from "../src/lib/assistant";
import { DEFAULT_ASSISTANT_MODEL } from "../src/lib/settings";
import { parseJson } from "../src/lib/schemas";

const SPEC = join(import.meta.dir, "..", ".spec");

/** A named list value from a spec item. */
function specList(item: string, id: string): string[] {
  const parsed = z
    .object({ values: z.array(z.object({ id: z.string(), value: z.unknown() })).optional() })
    .parse(parseJson(readFileSync(join(SPEC, item), "utf8")));
  const value = parsed.values?.find((v) => v.id === id)?.value;
  return z.array(z.string()).parse(value);
}

describe("the assistant follows the spec's named values", () => {
  // Spec: AST-3
  test("its actions are exactly `assistant.actions`", () => {
    const spec = specList("assistant.json", "assistant.actions");
    expect(ASSISTANT_ACTIONS).toHaveLength(spec.length);
    // Each action is one of the spec's, in order; labels may be phrased for a button.
    const words = (s: string) => s.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    ASSISTANT_ACTIONS.forEach((a, i) => {
      const want = words(spec[i] ?? "");
      expect(want.some((w) => a.label.toLowerCase().includes(w))).toBe(true);
    });
  });

  test("its topics are `book.topics`", () => {
    expect([...BOOK_TOPICS]).toEqual(specList("book/index.json", "book.topics"));
  });
});

// Spec: AST-2, AST-3
describe("what the model is told", () => {
  test("it never writes the book and helps only in the listed ways", () => {
    expect(SYSTEM_PROMPT).toContain("never write text for the book");
    expect(SYSTEM_PROMPT).toContain("cannot change the book");
    for (const way of ["asking questions", "critiquing writing", "pointing out gaps in arguments", "suggesting sources", "quizzing"]) {
      expect(SYSTEM_PROMPT).toContain(way);
    }
  });

  test("the brief, then the page as it is now, then the conversation", () => {
    const turns = [actionTurn("gaps"), { role: "assistant" as const, content: "Step 2 assumes …" }, { role: "user" as const, content: "Why?" }];
    const messages = buildMessages("Curry–Howard", "A proof is a program.", turns);
    expect(messages.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user"]);
    expect(messages[1]?.content).toContain("A proof is a program.");
    expect(messages[1]?.content).toContain('title="Curry–Howard"');
    expect(messages[2]?.content).toContain("gaps in the arguments");
    expect(messages[4]?.content).toBe("Why?");
  });

  test("an empty page says so", () => {
    expect(buildMessages("New", "  ", [])[1]?.content).toContain("empty so far");
  });

  test("an action's turn remembers which action it was", () => {
    expect(actionTurn("quiz").action).toBe("quiz");
  });
});

test("the default model is an OpenRouter id", () => {
  expect(DEFAULT_ASSISTANT_MODEL).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
});
