/**
 * The single home for parsing untrusted JSON: database columns, model
 * output, external APIs and settings blobs. Every boundary gets a zod schema
 * and a small parse helper, so call sites never touch raw `unknown` or cast
 * with `as`. ESLint bans `JSON.parse` outside this file (see eslint.config.js
 * and CLAUDE.md).
 */
import { z } from "zod";

/**
 * The one sanctioned `JSON.parse`: always feed the result to a schema.
 * (eslint.config.js exempts this file from the ban.)
 */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

// ---------------------------------------------------------------------------
// What commands and the SQL plugin hand back
// ---------------------------------------------------------------------------


const LooseRecordSchema = z.record(z.string(), z.unknown());

/** Rows from tauri-plugin-sql's `select`: objects keyed by column, values still unchecked. */
export function parseSqlRows(raw: unknown): Record<string, unknown>[] {
  return z.array(LooseRecordSchema).parse(raw);
}

/** A command that answers with a string. */
export function parseCommandString(raw: unknown): string {
  return z.string().parse(raw);
}

/** A command that answers with a count. */
export function parseCommandCount(raw: unknown): number {
  return z.number().int().nonnegative().parse(raw);
}

/** A command that answers yes or no. */
export function parseCommandFlag(raw: unknown): boolean {
  return z.boolean().parse(raw);
}
