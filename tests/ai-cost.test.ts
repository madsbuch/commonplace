import { describe, expect, test } from "bun:test";
import { featureInfo, formatTokens, formatUsd, groupBy, shiftDay, spendOver, totalOf, type UsageRow } from "../src/lib/aiCost";

function row(day: string, feature: string, model: string, costUsd: number, requests = 1): UsageRow {
  return { day, feature, model, requests, promptTokens: 100 * requests, completionTokens: 10 * requests, costUsd };
}

const rows: UsageRow[] = [
  row("2026-11-01", "assistant", "anthropic/claude-sonnet-5.5", 0.5, 2),
  row("2026-11-01", "connection_test", "anthropic/claude-sonnet-5.5", 0.001),
  row("2026-11-03", "assistant", "google/gemini-4-neon", 0.25, 3),
  row("2026-11-07", "assistant", "anthropic/claude-sonnet-5.5", 1),
];

// Spec: AI-4
describe("cost roll-ups", () => {
  test("total sums everything", () => {
    const t = totalOf(rows);
    expect(t.requests).toBe(7);
    expect(t.promptTokens).toBe(700);
    expect(t.completionTokens).toBe(70);
    expect(t.costUsd).toBeCloseTo(1.751, 6);
  });

  test("by feature, most expensive first", () => {
    const g = groupBy(rows, "feature");
    expect(g.map((x) => x.key)).toEqual(["assistant", "connection_test"]);
    expect(g[0]?.costUsd).toBeCloseTo(1.75, 6);
    expect(g[0]?.requests).toBe(6);
  });

  test("by model, most expensive first", () => {
    const g = groupBy(rows, "model");
    expect(g.map((x) => x.key)).toEqual(["anthropic/claude-sonnet-5.5", "google/gemini-4-neon"]);
    expect(g[0]?.costUsd).toBeCloseTo(1.501, 6);
  });

  test("spend over time fills empty days with zero", () => {
    const b = spendOver(rows, "2026-11-01", "2026-11-07", 1);
    expect(b).toHaveLength(7);
    expect(b.map((x) => x.start)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
    expect(b[0]?.costUsd).toBeCloseTo(0.501, 6);
    expect(b[1]?.costUsd).toBe(0);
    expect(b[6]?.costUsd).toBe(1);
  });

  test("buckets are built back from the last day, the newest whole", () => {
    const b = spendOver(rows, "2026-11-01", "2026-11-07", 3);
    expect(b.map((x) => [x.start, x.end])).toEqual([
      ["2026-11-01", "2026-11-01"],
      ["2026-11-02", "2026-11-04"],
      ["2026-11-05", "2026-11-07"],
    ]);
    expect(b[0]?.costUsd).toBeCloseTo(0.501, 6);
    expect(b[1]?.costUsd).toBeCloseTo(0.25, 6);
    expect(b[2]?.costUsd).toBe(1);
  });

  test("rows outside the range don't count", () => {
    const b = spendOver(rows, "2026-11-02", "2026-11-04", 1);
    expect(b.reduce((s, x) => s + x.costUsd, 0)).toBeCloseTo(0.25, 6);
  });

  test("days shift across month ends", () => {
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("formatting", () => {
  test("dollars", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(123.4)).toBe("$123");
  });

  test("tokens", () => {
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(34_000)).toBe("34k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  test("features have names; unknown ones show as logged", () => {
    expect(featureInfo("assistant").label).toBe("Writing assistant");
    expect(featureInfo("something_new").label).toBe("something_new");
  });
});
