// ---------------------------------------------------------------------------
// Lean blocks' I/O: their verdicts as stored (they sync), and on a computer
// the Lean service in Rust (src-tauri/src/lean/), which checks a block, reads
// the proof state at a position, and sets up Lean with Mathlib. Phones don't
// run Lean (LEAN-7): there, only the stored verdicts.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { select } from "./db";
import { hashInput, isModuleName } from "./leanModel";
import { notifyTablesChanged } from "./live";
import {
  LeanGoalsSchema,
  LeanServiceStatusSchema,
  LeanSetupEventSchema,
  LeanVerdictSchema,
  parseLeanCheckRow,
  type LeanGoals,
  type LeanServiceStatus,
  type LeanVerdict,
} from "./schemas";
import { isAndroid } from "./sync";

export const LEAN_TABLES = ["blocks", "lean_checks"];

// Spec: LEAN-7
/** Whether this device runs Lean: computers do, phones don't. */
export function runsLean(): boolean {
  return !isAndroid();
}

// Spec: LEAN-5
/** SHA-256 in hex, as the Rust side computes it. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function leanHash(name: string, source: string): Promise<string> {
  return sha256Hex(hashInput(name, source));
}

export async function storedVerdict(blockId: string): Promise<LeanVerdict | null> {
  const [row] = await select(`SELECT * FROM lean_checks WHERE block_id = $1`, [blockId]);
  return row ? parseLeanCheckRow(row) : null;
}

/** The book's named Lean blocks: name to block id (the smallest id holds a shared name) and to hash. */
export async function leanIndex(): Promise<{ ids: Map<string, string>; hashes: Map<string, string> }> {
  const rows = await select(`SELECT id, json_extract(props, '$.name') AS name, json_extract(content, '$') AS source FROM blocks WHERE type = 'lean' AND deleted_at IS NULL ORDER BY id`);
  const ids = new Map<string, string>();
  const hashes = new Map<string, string>();
  for (const r of rows) {
    const id = r["id"];
    const name = r["name"];
    const source = r["source"];
    if (typeof id !== "string" || typeof name !== "string" || typeof source !== "string" || !isModuleName(name) || ids.has(name)) continue;
    ids.set(name, id);
    hashes.set(name, await leanHash(name, source));
  }
  return { ids, hashes };
}

// Spec: LEAN-3
/** Checks a block on this computer as it is in the editor; the verdict is saved and syncs. */
export async function leanCheck(blockId: string, name: string, source: string): Promise<LeanVerdict> {
  const verdict = LeanVerdictSchema.parse(await invoke("lean_check", { blockId, name, source }));
  notifyTablesChanged(["lean_checks"]);
  return verdict;
}

// Spec: LEAN-4
export async function leanGoal(blockId: string, name: string, source: string, line: number, character: number): Promise<LeanGoals> {
  return LeanGoalsSchema.parse(await invoke("lean_goal", { blockId, name, source, line, character }));
}

/** `leanprover/lean4:v4.21.0` as `v4.21.0`. */
export function leanVersion(toolchain: string | null): string {
  return toolchain?.split(":").pop() ?? "";
}

export async function leanStatus(): Promise<LeanServiceStatus> {
  return LeanServiceStatusSchema.parse(await invoke("lean_status"));
}

// Spec: LEAN-8
/** Sets up Lean and Mathlib here; `onLine` gets what it prints, `onDone` the outcome. Returns a way to stop listening. */
export async function leanSetUp(onLine: (line: string) => void, onDone: (error: string | null) => void): Promise<() => void> {
  const stop = await listen("lean-setup", (e) => {
    const ev = LeanSetupEventSchema.safeParse(e.payload);
    if (!ev.success) return;
    if (ev.data.line !== undefined) onLine(ev.data.line);
    if (ev.data.done) onDone(ev.data.error ?? null);
  });
  try {
    await invoke("lean_set_up");
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}

/** Verdicts reached in the background (LEAN-6) refresh what shows them. */
export function followLeanChecks(): void {
  if (!runsLean()) return;
  void listen("lean-checked", () => notifyTablesChanged(["lean_checks"])).catch(() => undefined);
}
