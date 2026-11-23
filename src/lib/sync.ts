// ---------------------------------------------------------------------------
// Sync between this device and the book's other devices (src-tauri/src/sync/).
// Everything happens in Rust; this is the frontend's side: starting it,
// reading its status, pairing, and refreshing the screens when data arrives.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { parseCommandString } from "./schemas";

const SyncDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  isSelf: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastCompleteAt: z.string().nullable(),
  complete: z.boolean(),
});
export type SyncDevice = z.infer<typeof SyncDeviceSchema>;

const SyncStatusSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  platform: z.string(),
  inBook: z.boolean(),
  devices: z.array(SyncDeviceSchema),
  canJoin: z.boolean(),
  /** What this device holds, when it holds anything: table and row count. */
  held: z.array(z.object({ table: z.string(), rows: z.number() })),
  offerActive: z.boolean(),
  syncing: z.boolean(),
  lastError: z.string().nullable(),
  lastRoundAt: z.string().nullable(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

const SyncOutcomeSchema = z.object({
  peer_id: z.string(),
  peer_name: z.string(),
  received: z.object({
    applied: z.number(),
    conflicts: z.number(),
    unique_merges: z.number(),
  }),
  complete: z.boolean(),
  differences: z.array(z.string()),
});
export type SyncOutcome = z.infer<typeof SyncOutcomeSchema>;

const JoinResultSchema = z.object({
  outcome: SyncOutcomeSchema,
  /** Where the copy of this device's own data was saved, when it held any. */
  backup: z.string().nullable(),
});
export type JoinResult = z.infer<typeof JoinResultSchema>;

/** What every pairing code starts with (session.rs, `OFFER_PREFIX`). */
export const PAIRING_PREFIX = "mybook-pair:";

/** Starts listening, discovery and the sync loop (once; later calls are no-ops). */
export async function startSync(): Promise<void> {
  await invoke("sync_start");
}

// Spec: SYN-16
/** Gives this database a new device id if it was written elsewhere. Before anything writes. */
export async function checkInstance(): Promise<void> {
  await invoke("sync_check_instance");
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return SyncStatusSchema.parse(await invoke("sync_status"));
}

export async function setDeviceName(name: string): Promise<void> {
  await invoke("sync_set_name", { name });
}

// Spec: SYN-9
/** A pairing code for the QR, good for one device for `sync.pairing-lifetime`. */
export async function createPairingCode(): Promise<string> {
  return parseCommandString(await invoke("sync_offer"));
}

export async function cancelPairing(): Promise<void> {
  await invoke("sync_cancel_offer");
}

/**
 * Joins the book the code came from. This device must be empty, unless
 * `replace`: then a copy of what it holds is saved first, and replaced.
 */
export async function joinBook(code: string, replace = false): Promise<JoinResult> {
  return JoinResultSchema.parse(await invoke("sync_join", { code, replace }));
}

const TABLE_LABELS: Record<string, [string, string]> = {
  blocks: ["block", "blocks"],
  revisions: ["revision", "revisions"],
  ai_usage: ["AI request", "AI requests"],
};

/** "12 blocks, 40 revisions and 3 other records": what a device holds, in words. */
export function describeHeld(held: { table: string; rows: number }[]): string {
  const named: string[] = [];
  let other = 0;
  for (const h of held) {
    const label = TABLE_LABELS[h.table];
    if (label) named.push(`${h.rows} ${h.rows === 1 ? label[0] : label[1]}`);
    else other += h.rows;
  }
  if (other) named.push(`${other} other ${other === 1 ? "record" : "records"}`);
  if (named.length <= 1) return named[0] ?? "nothing";
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1] ?? ""}`;
}

export async function syncNow(): Promise<void> {
  await invoke("sync_now");
}

export async function removeDevice(id: string): Promise<void> {
  await invoke("sync_remove_device", { id });
}

function listenTo(event: string, fn: () => void): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  void listen(event, () => fn()).then((u) => {
    if (stopped) u();
    else stop = u;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}

/** Calls `fn` whenever another device's data arrived here. */
export function onSyncChanged(fn: () => void): () => void {
  return listenTo("sync-changed", fn);
}

/** Calls `fn` whenever sync's status moved (a round started or ended). */
export function onSyncStatus(fn: () => void): () => void {
  return listenTo("sync-status", fn);
}

/** A copy on another device older than this is worth a mention. */
export const STALE_COPY_MS = 3 * 24 * 3600_000;

/**
 * How this device's copy stands elsewhere. kind: "none" (alone, or not in a
 * book), "ok", "stale" (too long ago), "incomplete" (the last sync didn't
 * end identical). peer: the other device, by name. completeAt: when both
 * last held exactly the same data.
 */
export type CopyState =
  | { kind: "none"; peer: null; completeAt: null }
  | { kind: "ok" | "stale"; peer: string; completeAt: string }
  | { kind: "incomplete"; peer: string; completeAt: string | null };

export function copyState(status: SyncStatus, now: number = Date.now()): CopyState {
  const others = status.devices.filter((d) => !d.isSelf);
  if (!status.inBook || others.length === 0) return { kind: "none", peer: null, completeAt: null };
  // The most recently complete of the others; ties go to the first listed.
  let best: SyncDevice | null = null;
  for (const d of others) {
    if (d.lastCompleteAt && (!best?.lastCompleteAt || d.lastCompleteAt > best.lastCompleteAt)) best = d;
  }
  const peer = best ?? others[0];
  if (!peer) return { kind: "none", peer: null, completeAt: null };
  const at = peer.lastCompleteAt;
  if (!at) return { kind: "incomplete", peer: peer.name, completeAt: null };
  if (now - Date.parse(at) > STALE_COPY_MS) return { kind: "stale", peer: peer.name, completeAt: at };
  if (!peer.complete) return { kind: "incomplete", peer: peer.name, completeAt: at };
  return { kind: "ok", peer: peer.name, completeAt: at };
}

/** "5 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** One line on how the book stands across devices. */
export function copyLine(state: CopyState, now: number = Date.now()): string {
  switch (state.kind) {
    case "none":
      return "Only on this device";
    case "ok":
      return `In sync with ${state.peer} · ${ago(state.completeAt, now)} · identical`;
    case "stale":
      return `Last in sync with ${state.peer} ${ago(state.completeAt, now)}`;
    case "incomplete":
      return state.completeAt
        ? `Syncing with ${state.peer} · last identical ${ago(state.completeAt, now)}`
        : `Syncing with ${state.peer} · not identical yet`;
  }
}

export function isAndroid(): boolean {
  return navigator.userAgent.includes("Android");
}

// ---------------------------------------------------------------------------
// Checking the connection
// ---------------------------------------------------------------------------

const CheckReportSchema = z.object({
  verdict: z.string(),
  /** A setting that would fix it: "local-network" (macOS's Local Network privacy). */
  fix: z.string().nullable(),
  lines: z.array(z.object({ ok: z.boolean().nullable(), text: z.string() })),
});
export type CheckReport = z.infer<typeof CheckReportSchema>;

// Spec: SYN-23
/** Checks the connection to the book's devices (and the code last joined); a few seconds. */
export async function checkConnection(): Promise<CheckReport> {
  return CheckReportSchema.parse(await invoke("sync_check"));
}

// Spec: SYN-24
/** macOS's Local Network privacy settings, where the app is let onto the local network. */
export const LOCAL_NETWORK_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork";

/** Whether a sync error says macOS keeps the app off the local network. */
export function blockedByLocalNetwork(error: string): boolean {
  return error.includes("Privacy & Security → Local Network");
}
