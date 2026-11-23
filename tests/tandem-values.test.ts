// The sync code's constants follow the named values of the shared part
// Tandem (`.spec/tandem`), as the book sets them: the part's own value, or
// the one in the import's `values` when the book sets it differently.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../src/lib/schemas";

const ROOT = join(import.meta.dir, "..");

const Values = z.object({
  values: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.number(), z.array(z.string())]) })).optional(),
});
const Root = z.object({
  imports: z
    .array(
      z.object({
        id: z.string(),
        values: z
          .array(z.object({ id: z.string(), value: z.union([z.string(), z.number(), z.array(z.string())]) }))
          .optional(),
      }),
    )
    .optional(),
});

function readSpec(path: string): unknown {
  return parseJson(readFileSync(join(ROOT, ".spec", path), "utf8"));
}

/** A Tandem value as the book sets it. */
function tandemValue(file: string, id: string): string {
  const override = Root.parse(readSpec("index.json"))
    .imports?.find((imp) => imp.id === "tandem")
    ?.values?.find((v) => v.id === id)?.value;
  const own = Values.parse(readSpec(`tandem/${file}`)).values?.find((v) => v.id === id)?.value;
  const value = override ?? own;
  if (typeof value !== "string") throw new Error(`${id} isn't a duration in the spec`);
  return value;
}

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400 };

/** A spec duration (`10min`, `14d`) in seconds. */
function seconds(duration: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|min|h|d)$/.exec(duration);
  const unit = m?.[2] === undefined ? undefined : UNIT_SECONDS[m[2]];
  if (m?.[1] === undefined || unit === undefined) throw new Error(`not a duration: ${duration}`);
  return Number(m[1]) * unit;
}

/** A product of integer literals, as the Rust constants are written (`10 * 60`, `14`). */
function product(expr: string): number {
  return expr.split("*").reduce((n, factor) => n * Number(factor.trim().replaceAll("_", "")), 1);
}

/** The expression a Rust constant is set to, from its declaration. */
function rustConst(file: string, pattern: RegExp): number {
  const m = pattern.exec(readFileSync(join(ROOT, "src-tauri/src", file), "utf8"));
  if (m?.[1] === undefined) throw new Error(`${file}: constant not found by ${pattern}`);
  const n = product(m[1]);
  if (!Number.isFinite(n)) throw new Error(`${file}: ${m[1]} isn't a product of numbers`);
  return n;
}

describe("Tandem's named values in the sync code", () => {
  // Spec: tandem.SYN-9
  test("a pairing code works for tandem.pairing-lifetime", () => {
    const ttl = rustConst("sync/session.rs", /pub const PAIRING_TTL: Duration = Duration::from_secs\(([^)]+)\);/);
    expect(ttl).toBe(seconds(tandemValue("pairing.json", "tandem.pairing-lifetime")));
  });

  // Spec: tandem.SYN-18
  test("daily snapshots are kept for tandem.snapshot-daily", () => {
    const days = rustConst("sync/snapshots.rs", /pub const DAILY: i64 = ([^;]+);/);
    expect(days * 86400).toBe(seconds(tandemValue("snapshots.json", "tandem.snapshot-daily")));
  });

  // Spec: tandem.SYN-18
  test("weekly snapshots are kept back to tandem.snapshot-weekly", () => {
    const days = rustConst("sync/snapshots.rs", /pub const WEEKLY_UNTIL: i64 = ([^;]+);/);
    expect(days * 86400).toBe(seconds(tandemValue("snapshots.json", "tandem.snapshot-weekly")));
  });
});
