// ---------------------------------------------------------------------------
// The diagnostics (DIAG-1 to DIAG-6): what happened in the app on this
// device, kept in `diagnostics` (never synced) to be read and copied whole
// for a coding agent. The frontend notes its own here: every error nothing
// caught, console errors and warnings, the work it does (lib/work.ts), model
// requests that failed, and the screens it went through. Rust notes its own
// (src-tauri/src/diagnostics.rs) in the same table.
//
// Entries are queued and written a moment later, a batch at a time; what
// can't be written is let go, quietly, so noting never fails anything.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { execute, select } from "./db";
import { notifyTablesChanged } from "./live";

export type Level = "error" | "warning" | "info";

// Spec: DIAG-1
/** `diagnostics.kept`. */
export const KEPT_MS = 14 * 24 * 60 * 60 * 1000;
/** `diagnostics.most`. */
export const MOST = 5000;
const MOST_MESSAGE = 2_000;
const MOST_DETAILS = 20_000;
/** How long notes gather before they're written. */
const BATCH_MS = 300;

export interface DiagnosticEntry {
  id: number;
  at: number;
  level: Level;
  source: string;
  message: string;
  details: string | null;
  screen: string | null;
}

type Pending = Omit<DiagnosticEntry, "id">;

const queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let writing = false;

// The console as it was, for what goes wrong in noting itself.
const quiet = { warn: console.warn.bind(console) };

function cut(s: string, most: number): string {
  return s.length <= most ? s : `${s.slice(0, most)}…`;
}

// Spec: DIAG-5
/** `s` with anything shaped like an OpenRouter key, or a bearer token, masked. */
export function maskKeys(s: string): string {
  return s.replace(/Bearer [A-Za-z0-9_.-]+/g, "Bearer …").replace(/sk-or-[A-Za-z0-9_.-]+/g, "sk-or-…");
}

/** What an error says. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** An error's stack, or whatever more there is to it. */
export function detailsOf(e: unknown): string | null {
  if (e instanceof Error) return e.stack ?? null;
  if (e !== null && typeof e === "object") {
    try {
      return JSON.stringify(e, null, 2);
    } catch {
      return null;
    }
  }
  return null;
}

function screen(): string | null {
  return typeof location === "undefined" ? null : `${location.pathname}${location.search}${location.hash}`;
}

// Spec: DIAG-1
/** Notes what happened: `source` is what it came from ("assistant", "audio", "library", …). */
export function note(level: Level, source: string, message: string, details?: string | null): void {
  queue.push({
    at: Date.now(),
    level,
    source,
    message: cut(maskKeys(message), MOST_MESSAGE),
    details: details ? cut(maskKeys(details), MOST_DETAILS) : null,
    screen: screen(),
  });
  timer ??= setTimeout(() => void flush(), BATCH_MS);
}

/** Writes what's queued. */
export async function flush(): Promise<void> {
  timer = null;
  if (writing) {
    timer = setTimeout(() => void flush(), BATCH_MS);
    return;
  }
  const batch = queue.splice(0, 200);
  if (batch.length === 0) return;
  writing = true;
  try {
    const values = batch.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(", ");
    await execute(
      `INSERT INTO diagnostics (at, level, source, message, details, screen) VALUES ${values}`,
      batch.flatMap((e) => [e.at, e.level, e.source, e.message, e.details, e.screen]),
    );
    notifyTablesChanged(["diagnostics"]);
  } catch (e) {
    quiet.warn("Diagnostics couldn't be written", e);
  } finally {
    writing = false;
    if (queue.length > 0) timer ??= setTimeout(() => void flush(), BATCH_MS);
  }
}

// Spec: DIAG-1
/** Lets go of what's older than `diagnostics.kept`, and past `diagnostics.most`. */
export async function trim(now = Date.now()): Promise<void> {
  await execute(`DELETE FROM diagnostics WHERE at < $1 OR id <= (SELECT max(id) FROM diagnostics) - $2`, [now - KEPT_MS, MOST]);
}

const LEVELS: readonly Level[] = ["error", "warning", "info"];

function entryOf(r: Record<string, unknown>): DiagnosticEntry | null {
  const { id, at, level, source, message, details, screen } = r;
  if (typeof id !== "number" || typeof at !== "number" || typeof source !== "string" || typeof message !== "string") return null;
  const lvl = LEVELS.find((l) => l === level);
  if (!lvl) return null;
  return { id, at, level: lvl, source, message, details: typeof details === "string" ? details : null, screen: typeof screen === "string" ? screen : null };
}

/** The log, newest first; only failures (errors and warnings) when asked. */
export async function loadDiagnostics(opts: { failuresOnly?: boolean; limit?: number } = {}): Promise<DiagnosticEntry[]> {
  const where = opts.failuresOnly ? `WHERE level IN ('error', 'warning')` : "";
  const rows = await select(`SELECT id, at, level, source, message, details, screen FROM diagnostics ${where} ORDER BY at DESC, id DESC LIMIT $1`, [
    opts.limit ?? MOST,
  ]);
  return rows.flatMap((r) => entryOf(r) ?? []);
}

/** How many things failed since `since`. */
export async function failuresSince(since: number): Promise<number> {
  const [row] = await select(`SELECT count(*) AS n FROM diagnostics WHERE level = 'error' AND at >= $1`, [since]);
  const n = row?.["n"];
  return typeof n === "number" ? n : 0;
}

// Spec: DIAG-6
export async function emptyDiagnostics(): Promise<void> {
  await execute(`DELETE FROM diagnostics`);
  notifyTablesChanged(["diagnostics"]);
}

function argText(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.message;
  return messageOf(a);
}

let installed = false;

// Spec: DIAG-1, DIAG-2
/**
 * Starts noting what nothing else catches: uncaught errors and rejections,
 * console errors and warnings. Once, at start.
 */
export function installDiagnostics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    const err: unknown = ev.error;
    const message = ev.message || messageOf(err);
    note("error", "app", message.startsWith("Uncaught") ? message : `Uncaught: ${message}`, detailsOf(err) ?? `${ev.filename}:${ev.lineno}:${ev.colno}`);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason: unknown = ev.reason;
    note("error", "app", `Unhandled: ${messageOf(reason)}`, detailsOf(reason));
  });
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const error = args.find((a) => a instanceof Error);
      note(level === "error" ? "error" : "warning", "console", args.map(argText).join(" "), detailsOf(error));
    };
  }
  void trim().catch(() => undefined);
}

let lastScreen = "";

/** Notes a screen opened (the router's navigations; scrolling within one isn't one). */
export function noteScreen(pathname: string, search: string): void {
  const at = `${pathname}${search}`;
  if (at === lastScreen) return;
  lastScreen = at;
  note("info", "screen", `Opened ${at}`);
}

// Spec: DIAG-1
/** A screen's failure line, as useState holds one, noted in the diagnostics whenever one shows. */
export function useNotedProblem(source: string, level: Level = "warning"): [string | null, (message: string | null) => void] {
  const [problem, setProblem] = useState<string | null>(null);
  const set = useCallback(
    (message: string | null) => {
      if (message) note(level, source, message);
      setProblem(message);
    },
    [source, level],
  );
  return [problem, set];
}
