// ---------------------------------------------------------------------------
// Finding the book's devices nearby, as Murmur does (tandem.SYN-5): the LAN plugin
// (src-tauri/plugins/lan: Android's NsdManager, mDNS on computers)
// announces this device (`_commonplace._tcp`: its sync port, its id, the
// book's tag, and while a code is on screen the code's tag) and finds the
// others, every address each has, IPv6 included. Each one found is passed
// to Rust (`sync_peer_found`), which syncs with the book's and finds the
// device showing a code being joined. What's announced is asked of Rust
// (`sync_announce`) and announced again whenever it changes.
// ---------------------------------------------------------------------------

import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { messageOf, note } from "./diagnostics";

const AnnounceSchema = z
  .object({ serviceName: z.string(), port: z.number(), deviceId: z.string(), book: z.string(), pair: z.string() })
  .nullable();

const PeerSchema = z.object({
  deviceId: z.string(),
  book: z.string().catch(""),
  pair: z.string().catch(""),
  addresses: z.array(z.string()).max(32),
  port: z.number().int().min(1).max(65535),
});

let announced = "";
let listening: Promise<void> | null = null;
let chain: Promise<void> = Promise.resolve();
let lastProblem = "";

function problem(message: string): void {
  // Noted once until it changes: discovery retries by itself.
  if (message === lastProblem) return;
  lastProblem = message;
  note("warning", "sync", `Finding devices nearby: ${message}`);
}

function onPeer(payload: unknown): void {
  const peer = PeerSchema.safeParse(payload);
  if (!peer.success) return;
  void invoke("sync_peer_found", { peer: peer.data }).catch((e: unknown) => problem(messageOf(e)));
}

function onError(payload: unknown): void {
  const message = z.object({ message: z.string() }).safeParse(payload);
  problem(message.success ? message.data.message : "the LAN plugin failed");
}

/** Listens for what the plugin finds, once. */
function listenOnce(): Promise<void> {
  listening ??= (async () => {
    const mobile = z.boolean().parse(await invoke("plugin:lan|is_mobile"));
    if (mobile) {
      await addPluginListener("lan", "peer", onPeer);
      await addPluginListener("lan", "error", onError);
    } else {
      await listen("lan-peer", (e) => onPeer(e.payload));
      await listen("lan-error", (e) => onError(e.payload));
    }
  })().catch((e: unknown) => {
    listening = null;
    throw e;
  });
  return listening;
}

// Spec: tandem.SYN-5
/** Announces this device as it is now (again only if that changed); `force` announces afresh. */
export function announceNearby(force = false): Promise<void> {
  chain = chain
    .catch(() => undefined)
    .then(async () => {
      await listenOnce();
      const config = AnnounceSchema.parse(await invoke("sync_announce"));
      const key = config ? JSON.stringify(config) : "";
      if (key === announced && !force) return;
      await invoke("plugin:lan|stop");
      announced = "";
      if (config) {
        await invoke("plugin:lan|start", { config });
        announced = key;
        lastProblem = "";
      }
    })
    .catch((e: unknown) => problem(messageOf(e)));
  return chain;
}

// Back in sight, announce afresh: Android stops announcing while the app is paused.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void announceNearby(true);
  });
}
