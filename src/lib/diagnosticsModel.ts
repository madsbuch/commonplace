// ---------------------------------------------------------------------------
// The diagnostics as one text for a coding agent (DIAG-4), without I/O: what
// the app is and how it's set up, what runs now, then the log oldest first,
// each entry with its time to the millisecond. Keys are masked once more on
// the way out (DIAG-5).
// ---------------------------------------------------------------------------

import { maskKeys, type DiagnosticEntry } from "./diagnostics";

/** A moment as the log shows it: local time to the millisecond, with its offset from UTC. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")} ` +
    `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
  );
}

/** How long, as a person says it. */
export function lasting(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** One entry, as the copy has it: a line, then its details indented. */
export function entryText(e: DiagnosticEntry): string {
  const head = `${stamp(e.at)}  ${e.level.toUpperCase().padEnd(7)}  ${e.source.padEnd(9)}  ${e.message}`;
  const more: string[] = [];
  if (e.screen && e.source !== "screen") more.push(`on ${e.screen}`);
  if (e.details) more.push(...e.details.split("\n"));
  return [head, ...more.map((l) => `    ${l}`)].join("\n");
}

// Spec: DIAG-4, DIAG-5
/** The whole of it: `facts` about the app, what runs now, and the log (in any order; it's put oldest first). */
export function reportText(opts: {
  facts: readonly (readonly [string, string])[];
  running: readonly { title: string; since: number }[];
  entries: readonly DiagnosticEntry[];
  now: number;
}): string {
  const log = [...opts.entries].sort((a, b) => a.at - b.at || a.id - b.id);
  const first = log[0];
  const lines = [
    "# Commonplace diagnostics",
    "",
    `Copied ${stamp(opts.now)}.`,
    "",
    "## The app",
    "",
    ...opts.facts.map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Running now",
    "",
    ...(opts.running.length === 0 ? ["Nothing."] : opts.running.map((r) => `- ${r.title}, for ${lasting(opts.now - r.since)}`)),
    "",
    `## The log: ${log.length} ${log.length === 1 ? "entry" : "entries"}${first ? ` since ${stamp(first.at)}` : ""}, oldest first`,
    "",
    ...(log.length === 0 ? ["Nothing yet."] : log.map(entryText)),
    "",
  ];
  return maskKeys(lines.join("\n"));
}
