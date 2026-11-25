// ---------------------------------------------------------------------------
// What other apps share to this one (LIB-30): on Android the share sheet
// hands the app a web address or PDFs (the share-target plugin, which keeps
// them until taken). They're taken when the app starts, when it comes back
// to the front, and when the plugin says one arrived, then handed to the
// Library, which adds each as if it had been typed or uploaded there.
// Elsewhere nothing is ever shared.
// ---------------------------------------------------------------------------

import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { detailsOf, messageOf, note } from "./diagnostics";
import { bytesOf, MAX_FILE_BYTES, MAX_FILE_MB } from "./library";
import { go } from "./navigation";
import { isAndroid } from "./sync";
import { sharedAddress } from "./webModel";

/** What the plugin hands over: each share's text and files, a file's bytes in base64 unless it was too large. */
const SharesSchema = z.object({
  shares: z.array(
    z.object({
      text: z.string().nullish(),
      subject: z.string().nullish(),
      files: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().default(""),
            size: z.number().nullish(),
            data: z.string().nullish(),
            problem: z.string().nullish(),
          }),
        )
        .default([]),
    }),
  ),
});

/** A share, as the Library adds it: an address (null when the text holds none), or files. */
export type Share = { kind: "address"; text: string; address: string | null } | { kind: "files"; files: File[]; problems: string[] };

const waiting: Share[] = [];
const listeners = new Set<() => void>();

/** The next share for the Library to add, taken from the queue. */
export function nextShare(): Share | undefined {
  return waiting.shift();
}

/** Calls `fn` whenever shares arrive; returns the unsubscribe. */
export function onShares(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function shareOf(s: z.infer<typeof SharesSchema>["shares"][number]): Share {
  // Files win over the words that come with them ("Look at this").
  if (s.files.length > 0) {
    const files: File[] = [];
    const problems: string[] = [];
    for (const f of s.files) {
      if (f.problem) problems.push(`${f.name} couldn't be read: ${f.problem}.`);
      else if (!f.data) problems.push(`${f.name} is larger than ${MAX_FILE_MB} MB.`);
      else {
        const bytes = bytesOf(f.data);
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        files.push(new File([copy], f.name, { type: f.type }));
      }
    }
    return { kind: "files", files, problems };
  }
  const text = (s.text ?? s.subject ?? "").trim();
  return { kind: "address", text, address: sharedAddress(text) };
}

async function takeOnce(): Promise<void> {
  const raw: unknown = await invoke("plugin:share-target|take", { most: MAX_FILE_BYTES });
  const { shares } = SharesSchema.parse(raw);
  if (shares.length === 0) return;
  for (const s of shares) {
    const share = shareOf(s);
    waiting.push(share);
    // Spec: DIAG-1
    note(
      "info",
      "share",
      share.kind === "files" ? `Shared to the app: ${s.files.map((f) => f.name).join(", ")}` : `Shared to the app: ${share.address ?? "text without an address"}`,
    );
  }
  if (window.location.pathname !== "/library") go("/library");
  for (const fn of listeners) fn();
}

let taking = false;
let again = false;

/** Takes whatever has been shared; asked again while taking, it takes again after. */
async function take(): Promise<void> {
  if (taking) {
    again = true;
    return;
  }
  taking = true;
  try {
    do {
      again = false;
      await takeOnce();
    } while (again);
  } catch (e) {
    // Spec: DIAG-1
    note("warning", "share", `Taking what was shared failed: ${messageOf(e)}`, detailsOf(e));
  } finally {
    taking = false;
  }
}

// Spec: LIB-30
/** Takes shares now, when the app comes to the front and when one arrives; returns the stop. Started by the layout, once it can navigate. */
export function takeShares(): () => void {
  let stopped = false;
  let stopListening: (() => void) | null = null;
  const onVisible = () => {
    if (document.visibilityState === "visible") void take();
  };
  document.addEventListener("visibilitychange", onVisible);
  if (isAndroid()) {
    addPluginListener("share-target", "shared", () => void take())
      .then((l) => {
        if (stopped) void l.unregister();
        else stopListening = () => void l.unregister();
      })
      .catch((e: unknown) => note("warning", "share", `Listening for shares failed: ${messageOf(e)}`, detailsOf(e)));
  }
  void take();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    stopListening?.();
  };
}
