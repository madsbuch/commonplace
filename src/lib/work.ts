// ---------------------------------------------------------------------------
// Work the app does by itself on the author's behalf (WORK-1): each piece is
// begun and ended here, so that while any runs Rust keeps the app going out
// of sight (an Android foreground service with a notification, WORK-2; on a
// computer, no sleeping, WORK-3), and so the diagnostics note when it began,
// how it ended and how long it took (DIAG-1).
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { detailsOf, messageOf, note } from "./diagnostics";

export interface Work {
  /** Says better what it is, once that's known. */
  rename(title: string): void;
  done(): void;
  /** The author stopped it. */
  stopped(): void;
  failed(e: unknown): void;
}

/** "12 s", "3 min 5 s", as Rust's `work::took` says it. */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

let counter = 0;

// Spec: WORK-1, DIAG-1
/** Begins a piece of work; end it once, with `done`, `stopped` or `failed`. */
export function beginWork(source: string, title: string): Work {
  const id = `js:${Date.now().toString(36)}:${++counter}`;
  const started = Date.now();
  let current = title;
  let over = false;
  note("info", source, `Started: ${title}`);
  void invoke("work_begin", { id, title }).catch((e: unknown) => note("warning", "work", `The work couldn't be kept running out of sight: ${messageOf(e)}`));
  const end = (level: "info" | "error", word: string, extra?: string, details?: string | null) => {
    if (over) return;
    over = true;
    void invoke("work_end", { id }).catch(() => undefined);
    note(level, source, `${word}: ${current} (${took(Date.now() - started)})${extra ? `: ${extra}` : ""}`, details);
  };
  return {
    rename: (t) => {
      if (over || t === current) return;
      current = t;
      void invoke("work_begin", { id, title: t }).catch(() => undefined);
    },
    done: () => end("info", "Finished"),
    stopped: () => end("info", "Stopped"),
    failed: (e) => end("error", "Failed", messageOf(e), detailsOf(e)),
  };
}

/** Runs `fn` as a piece of work, ended by how it ends. */
export async function asWork<T>(source: string, title: string, fn: (work: Work) => Promise<T>): Promise<T> {
  const work = beginWork(source, title);
  try {
    const result = await fn(work);
    work.done();
    return result;
  } catch (e) {
    work.failed(e);
    throw e;
  }
}

const RunningSchema = z.array(z.object({ id: z.string(), title: z.string(), since: z.number() }));
export type RunningWork = z.infer<typeof RunningSchema>[number];

// Spec: DIAG-3
/** What runs now, Rust's work and the frontend's. */
export async function runningWork(): Promise<RunningWork[]> {
  return RunningSchema.parse(await invoke("work_running"));
}
