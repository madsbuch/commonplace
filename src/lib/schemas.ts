/**
 * The single home for parsing untrusted JSON: database columns, model
 * output, external APIs and settings blobs. Every boundary gets a zod schema
 * and a small parse helper, so call sites never touch raw `unknown` or cast
 * with `as`. ESLint bans `JSON.parse` outside this file (see eslint.config.js
 * and CLAUDE.md).
 */

/**
 * The one sanctioned `JSON.parse`: always feed the result to a schema.
 * (eslint.config.js exempts this file from the ban.)
 */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}
