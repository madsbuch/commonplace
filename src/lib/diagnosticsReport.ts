// ---------------------------------------------------------------------------
// Gathering the diagnostics' copy (DIAG-4): the app's version and build, the
// platform and device, how it's set up, what runs now, and the whole log.
// Each fact that can't be had says so instead of failing the copy.
// ---------------------------------------------------------------------------

import { getIdentifier, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { getApiKey, getAssistantModel } from "./aiSettings";
import { getScriptModel, getSpeechModel, getVoice } from "./audio";
import { loadDiagnostics, messageOf } from "./diagnostics";
import { reportText } from "./diagnosticsModel";
import { leanStatus, leanVersion, runsLean } from "./lean";
import { getDetailsModel } from "./libraryDetails";
import { buildLabel } from "./build";
import { copyLine, copyState, getSyncStatus, isAndroid } from "./sync";
import { runningWork } from "./work";

async function fact(get: () => Promise<string>): Promise<string> {
  try {
    return await get();
  } catch (e) {
    return `unknown (${messageOf(e)})`;
  }
}

/** What's true of this app on this device, as label and value. */
async function facts(): Promise<[string, string][]> {
  const [version, identifier, tauri, sync, ai, models, audio, lean] = await Promise.all([
    fact(getVersion),
    fact(getIdentifier),
    fact(getTauriVersion),
    fact(async () => {
      const s = await getSyncStatus();
      const others = s.devices.filter((d) => d.id !== s.deviceId).map((d) => d.name);
      return `${s.name} (${s.deviceId}, ${s.platform}); ${copyLine(copyState(s))}; ${s.inBook ? `in a book with ${others.length ? others.join(", ") : "no other device"}` : "not in a book"}${s.lastError ? `; last error: ${s.lastError}` : ""}`;
    }),
    fact(async () => ((await getApiKey()) ? "an OpenRouter key is set" : "no OpenRouter key")),
    fact(async () => `assistant ${await getAssistantModel()}, library details ${await getDetailsModel()}`),
    fact(async () => `script ${await getScriptModel()}, speech ${await getSpeechModel()}, voice ${await getVoice()}`),
    fact(async () => {
      if (!runsLean()) return "verified on the computers, not here";
      const s = await leanStatus();
      return s.settingUp ? "setting up" : s.ready ? `ready, Lean ${leanVersion(s.toolchain)}` : s.lake ? "not set up" : "not installed";
    }),
  ]);
  const dev = identifier.endsWith(".dev");
  return [
    ["Version", `${version} (${dev ? "development" : "release"} build, ${identifier}; Tauri ${tauri})`],
    ["Build", buildLabel()],
    ["Platform", `${isAndroid() ? "Android" : navigator.platform || "unknown"}; ${navigator.userAgent}`],
    ["Screen", `${window.innerWidth}×${window.innerHeight} at ${window.devicePixelRatio}x, ${document.documentElement.getAttribute("data-theme") ?? "system"} theme`],
    ["Language and time zone", `${navigator.language}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}`],
    ["Device and sync", sync],
    ["AI", ai],
    ["Models", models],
    ["Recordings", audio],
    ["Lean", lean],
    ["On screen", `${location.pathname}${location.search}${location.hash}`],
  ];
}

// Spec: DIAG-4
/** The whole of the diagnostics, as one text to hand a coding agent. */
export async function diagnosticsReport(now = Date.now()): Promise<string> {
  const [f, running, entries] = await Promise.all([facts(), runningWork().catch(() => []), loadDiagnostics()]);
  return reportText({ facts: f, running, entries, now });
}
