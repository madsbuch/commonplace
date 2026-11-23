// The diagnostics' copy for a coding agent: its shape, its order, and that
// no key gets into it.
import { describe, expect, test } from "bun:test";
import { maskKeys, type DiagnosticEntry } from "../src/lib/diagnostics";
import { entryText, lasting, reportText, stamp } from "../src/lib/diagnosticsModel";
import { took } from "../src/lib/work";

const entry = (id: number, at: number, patch: Partial<DiagnosticEntry> = {}): DiagnosticEntry => ({
  id,
  at,
  level: "info",
  source: "assistant",
  message: `entry ${id}`,
  details: null,
  screen: "/chats/chat_1",
  ...patch,
});

// Spec: DIAG-4
describe("the copy", () => {
  test("a moment is local time to the millisecond, with its offset", () => {
    expect(stamp(Date.UTC(2026, 10, 23, 12, 0, 1, 7))).toMatch(/^2026-11-2\d \d\d:\d\d:01\.007 [+-]\d\d:\d\d$/);
  });

  test("it has the app's facts, what runs, and the log oldest first", () => {
    const now = Date.UTC(2026, 10, 23, 12, 0, 0);
    const text = reportText({
      facts: [["Version", "0.1.0 (release build)"]],
      running: [{ title: "Speaking “Attention”", since: now - 65_000 }],
      entries: [entry(2, now - 1000, { level: "error", message: "Failed: Answering", details: "Error: 402\n  at chatRound" }), entry(1, now - 5000)],
      now,
    });
    expect(text).toContain("- Version: 0.1.0 (release build)");
    expect(text).toContain("- Speaking “Attention”, for 1 min 5 s");
    expect(text).toContain("## The log: 2 entries since");
    expect(text.indexOf("entry 1")).toBeLessThan(text.indexOf("Failed: Answering"));
    expect(text).toContain("ERROR    assistant  Failed: Answering");
    expect(text).toContain("    on /chats/chat_1\n    Error: 402\n      at chatRound");
  });

  test("an empty log and no work say so", () => {
    const text = reportText({ facts: [], running: [], entries: [], now: 0 });
    expect(text).toContain("## Running now\n\nNothing.");
    expect(text).toContain("## The log: 0 entries, oldest first\n\nNothing yet.");
  });

  test("a screen opened isn't said to be on itself", () => {
    expect(entryText(entry(1, 0, { source: "screen", message: "Opened /library", screen: "/library" }))).not.toContain("    on ");
  });

  test("durations read as a person says them", () => {
    expect(lasting(12_400)).toBe("12 s");
    expect(lasting(3_725_000)).toBe("1 h 2 min");
    expect(took(185_000)).toBe("3 min 5 s");
  });
});

// Spec: DIAG-5
describe("the key", () => {
  test("is masked wherever it appears", () => {
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
    expect(maskKeys(`Authorization: Bearer ${key}`)).toBe("Authorization: Bearer …");
    expect(maskKeys(`the key ${key} failed`)).toBe("the key sk-or-… failed");
    const text = reportText({ facts: [["AI", key]], running: [], entries: [entry(1, 0, { details: key })], now: 0 });
    expect(text).not.toContain("0123456789abcdef");
  });
});
