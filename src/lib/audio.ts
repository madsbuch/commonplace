// ---------------------------------------------------------------------------
// The audio library's I/O (AUD-1 to AUD-9): making a recording's script here
// (a paper's text, by its sections, with the script model turning formulas
// into speech; or a summary of several papers), then handing it to Rust,
// which speaks and encodes it (src-tauri/src/audio/). Only the device that
// started a recording carries on with it: its script here, its audio there.
// ---------------------------------------------------------------------------

import { note } from "./diagnostics";
import { beginWork } from "./work";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { getApiKey } from "./aiSettings";
import {
  DEFAULT_SCRIPT_MODEL,
  DEFAULT_SPEECH_MODEL,
  DEFAULT_VOICE,
  isBibliography,
  MAX_SCRIPT_CHUNK,
  cut,
  parseSpoken,
  parseSummary,
  passages,
  summaryPrompt,
  SUMMARY_FORMAT,
  VERBATIM_FORMAT,
  VERBATIM_PROMPT,
  type ScriptChapter,
} from "./audioModel";
import { execute, getSetting, nowIso, select, setSetting } from "./db";
import { newId } from "./ids";
import { bytesOf, getItem, readFile, readHtml, type LibraryItem } from "./library";
import { notifyTablesChanged } from "./live";
import { chatJson, errorMessage } from "./openrouter";
import { AudioEventSchema, parseRecording, type Recording, type Script, type TocEntry } from "./schemas";
import { getSyncStatus } from "./sync";

export const AUDIO_TABLES = ["recordings", "recording_files", "listening"];

// Spec: AUD-5
export const SPEECH_MODEL_KEY = "speech_model";
export const VOICE_KEY = "speech_voice";
export const SCRIPT_MODEL_KEY = "audio_script_model";

export async function getSpeechModel(): Promise<string> {
  return (await getSetting(SPEECH_MODEL_KEY)) || DEFAULT_SPEECH_MODEL;
}
export async function getVoice(): Promise<string> {
  return (await getSetting(VOICE_KEY)) || DEFAULT_VOICE;
}
export async function getScriptModel(): Promise<string> {
  return (await getSetting(SCRIPT_MODEL_KEY)) || DEFAULT_SCRIPT_MODEL;
}
export async function saveAudioSetting(key: string, value: string): Promise<void> {
  await setSetting(key, value);
  notifyTablesChanged(["settings"]);
}

// Spec: AUD-1
export async function listRecordings(): Promise<Recording[]> {
  return (await select(`SELECT * FROM recordings ORDER BY created_at DESC`)).map(parseRecording);
}

export async function getRecording(id: string): Promise<Recording | null> {
  const [row] = await select(`SELECT * FROM recordings WHERE id = $1`, [id]);
  return row ? parseRecording(row) : null;
}

async function myDevice(): Promise<string> {
  try {
    return (await getSyncStatus()).deviceId;
  } catch {
    return "this-device";
  }
}

async function create(kind: "verbatim" | "summary", title: string, items: string[], section: string | null, minutes: number | null): Promise<string> {
  const id = newId("recordings");
  const at = nowIso();
  await execute(
    `INSERT INTO recordings (id, kind, title, items, section, minutes, voice, speech_model, status, progress, device, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'writing', 0, $9, $10, $10)`,
    [id, kind, title, JSON.stringify(items), section, minutes, await getVoice(), await getSpeechModel(), await myDevice(), at],
  );
  notifyTablesChanged(AUDIO_TABLES);
  void writeScript(id);
  return id;
}

// Spec: AUD-2
/**
 * Records an item verbatim: whole, or one section (`html:<anchor>` from its
 * HTML version, `toc:<index>` from its PDF's contents). Returns the recording's id.
 */
export async function recordVerbatim(itemId: string, section: { key: string; title: string } | null): Promise<string> {
  const item = await getItem(itemId);
  if (!item) throw new Error("No such item in the library.");
  return create("verbatim", section ? `${item.title}: ${section.title}` : item.title, [itemId], section?.key ?? null, null);
}

// Spec: AUD-4
export async function recordSummary(itemIds: string[], minutes: number): Promise<string> {
  const items = (await Promise.all(itemIds.map(getItem))).filter((i): i is LibraryItem => i !== null);
  if (items.length === 0) throw new Error("Choose a paper or book to summarize.");
  const title = items.length === 1 ? `Summary: ${items[0]?.title ?? ""}` : `Summary of ${items.length} works`;
  return create("summary", title, items.map((i) => i.id), null, minutes);
}

// ---------------------------------------------------------------------------
// The text to read: an item's sections, from its HTML version or its PDF
// ---------------------------------------------------------------------------

interface SourceChapter {
  title: string;
  text: string;
}

interface Flat {
  entry: TocEntry;
  depth: number;
}

function flatten(entries: readonly TocEntry[], depth = 0, out: Flat[] = []): Flat[] {
  for (const entry of entries) {
    out.push({ entry, depth });
    flatten(entry.children, depth + 1, out);
  }
  return out;
}

/** The entries a recording covers: all (the bibliography left out), or one and those within it. */
function scope(flat: readonly Flat[], from: number | null): Flat[] {
  if (from === null) {
    const out: Flat[] = [];
    let skipping: number | null = null;
    for (const f of flat) {
      if (skipping !== null && f.depth > skipping) continue;
      skipping = null;
      // Spec: AUD-3
      if (isBibliography(f.entry.title)) {
        skipping = f.depth;
        continue;
      }
      out.push(f);
    }
    return out;
  }
  const first = flat[from];
  if (!first) return [];
  const out = [first];
  for (const f of flat.slice(from + 1)) {
    if (f.depth <= first.depth) break;
    out.push(f);
  }
  return out;
}

/** The sections of an item's HTML version a recording reads, each without the sections within it. */
async function htmlChapters(item: LibraryItem, section: string | null): Promise<SourceChapter[] | null> {
  const html = await readHtml(item.id);
  if (html === null) return null;
  const { sanitizePaper, sectionsOf, textOf } = await import("./paperHtml");
  const root = new DOMParser().parseFromString(sanitizePaper(html), "text/html").body;
  const flat = flatten(sectionsOf(root));
  const anchor = section?.startsWith("html:") ? section.slice(5) : null;
  const from = anchor === null ? null : flat.findIndex((f) => f.entry.anchor === anchor);
  const chapters: SourceChapter[] = [];
  const own = (el: Element): string => {
    const copy = el.cloneNode(true);
    if (!(copy instanceof Element)) return "";
    for (const nested of copy.querySelectorAll("section[id]")) nested.remove();
    return textOf(copy);
  };
  if (from === null) {
    // What comes before the first section: the title, the authors, the abstract.
    const front = root.cloneNode(true);
    if (front instanceof Element) {
      for (const s of front.querySelectorAll("section[id]")) s.remove();
      const text = textOf(front);
      if (text.trim()) chapters.push({ title: item.title, text });
    }
  }
  for (const f of scope(flat, from === -1 ? null : from)) {
    const el = f.entry.anchor ? root.querySelector(`[id="${CSS.escape(f.entry.anchor)}"]`) : null;
    if (el) chapters.push({ title: f.entry.title, text: own(el) });
  }
  return chapters;
}

/** The sections of an item's PDF a recording reads, by its contents' pages (and titles, where a section starts mid-page). */
async function pdfChapters(item: LibraryItem, section: string | null): Promise<SourceChapter[]> {
  const { openPdf } = await import("./pdf");
  const pdf = await openPdf(await readFile(item.id));
  const pages: string[] = [];
  try {
    for (let i = 1; i <= pdf.doc.numPages; i++) {
      const content = await (await pdf.doc.getPage(i)).getTextContent();
      pages.push(content.items.map((t) => ("str" in t ? t.str + (t.hasEOL ? "\n" : " ") : "")).join(""));
    }
  } finally {
    pdf.close();
  }
  const flat = flatten(item.toc ?? []).filter((f) => f.entry.page !== null);
  if (flat.length === 0) return [{ title: item.title, text: pages.join("\n\n") }];
  const index = section?.startsWith("toc:") ? Number(section.slice(4)) : null;
  const chosen = scope(flat, index !== null && Number.isInteger(index) ? index : null);
  const squash = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const textOf = (f: Flat): string => {
    const at = flat.indexOf(f);
    const next = flat[at + 1];
    const start = (f.entry.page ?? 1) - 1;
    const end = next?.entry.page ? next.entry.page - 1 : pages.length - 1;
    let text = pages.slice(start, Math.max(start, end) + 1).join("\n\n");
    // From its own title, up to the next one's, where they can be found.
    const own = squash(text).indexOf(squash(f.entry.title));
    const flatText = text.replace(/\s+/g, " ");
    if (own >= 0) text = flatText.slice(own);
    if (next) {
      const cutAt = squash(text).indexOf(squash(next.entry.title), f.entry.title.length);
      if (cutAt > 0) text = text.replace(/\s+/g, " ").slice(0, cutAt);
    }
    return text;
  };
  const chapters: SourceChapter[] = [];
  if (index === null) {
    const first = flat[0];
    const front = first?.entry.page ? pages.slice(0, first.entry.page).join("\n\n") : "";
    const end = first ? squash(front).indexOf(squash(first.entry.title)) : -1;
    const text = end > 0 ? front.replace(/\s+/g, " ").slice(0, end) : "";
    if (text.trim()) chapters.push({ title: item.title, text });
  }
  for (const f of chosen) chapters.push({ title: f.entry.title, text: textOf(f) });
  return chapters;
}

/** An item's whole text, for a summary: its HTML version's, or its PDF's. */
async function wholeText(item: LibraryItem, budget: number): Promise<string> {
  const html = await readHtml(item.id);
  if (html !== null) {
    const { sanitizePaper, textOf } = await import("./paperHtml");
    return textOf(new DOMParser().parseFromString(sanitizePaper(html), "text/html").body).slice(0, budget);
  }
  return (await pdfChapters(item, null)).map((c) => `${c.title}\n\n${c.text}`).join("\n\n").slice(0, budget);
}

// ---------------------------------------------------------------------------
// Writing the script, then speaking it
// ---------------------------------------------------------------------------

/** What a summary can read of its sources in all, in characters. */
const SUMMARY_BUDGET = 90_000;

const writing = new Set<string>();

async function saveScript(id: string, script: Script, progress: number): Promise<void> {
  await execute(`UPDATE recordings SET script = $2, progress = $3, updated_at = $4 WHERE id = $1`, [id, JSON.stringify(script), progress, nowIso()]);
  notifyTablesChanged(["recordings"]);
}

async function fail(id: string, message: string): Promise<void> {
  await execute(`UPDATE recordings SET status = 'failed', error = $2, updated_at = $3 WHERE id = $1`, [id, message, nowIso()]);
  notifyTablesChanged(["recordings"]);
}

// Spec: AUD-3, AUD-4, AUD-6
/** Writes a recording's script (carrying on from the chapters already written), then has it spoken. */
export async function writeScript(id: string): Promise<void> {
  if (writing.has(id)) return;
  writing.add(id);
  // Spec: WORK-1, DIAG-1
  // Ended after Rust has begun speaking it, so the work never stops in between.
  const work = beginWork("audio", "Writing a recording's script");
  const failWith = async (message: string) => {
    work.failed(message);
    await fail(id, message);
  };
  try {
    const rec = await getRecording(id);
    if (!rec) return;
    work.rename(`Writing the script for “${rec.title}”`);
    const key = await getApiKey();
    if (!key) return await failWith("There's no OpenRouter key (Settings → AI and models).");
    const model = await getScriptModel();
    const items = (await Promise.all(rec.items.map(getItem))).filter((i): i is LibraryItem => i !== null);
    if (items.length === 0) return await failWith("Its papers are no longer in the library.");
    await execute(`UPDATE recordings SET status = 'writing', error = NULL, updated_at = $2 WHERE id = $1`, [id, nowIso()]);

    let script: Script;
    if (rec.kind === "summary") {
      const budget = Math.floor(SUMMARY_BUDGET / items.length);
      const works = await Promise.all(
        items.map(async (i, n) => `Work ${n + 1}: "${i.title}"${i.authors ? ` by ${i.authors}` : ""}${i.year ? ` (${i.year})` : ""}\n\n${await wholeText(i, budget)}`),
      );
      const raw = await chatJson(key, model, [{ role: "system", content: summaryPrompt(rec.minutes ?? 15) }, { role: "user", content: works.join("\n\n---\n\n") }], SUMMARY_FORMAT, {
        feature: "audio_script",
      });
      const summary = parseSummary(raw);
      if (summary.chapters.length === 0) return await failWith("The script model wrote nothing to read.");
      script = { chapters: summary.chapters.map((c): ScriptChapter => ({ title: c.title, paragraphs: passages(c.paragraphs) })) };
      if (summary.title) await execute(`UPDATE recordings SET title = $2 WHERE id = $1`, [id, summary.title]);
      await saveScript(id, script, 1);
    } else {
      const item = items[0];
      if (!item) return;
      const sources = (await htmlChapters(item, rec.section)) ?? (await pdfChapters(item, rec.section));
      // Carry on: chapters already written stay.
      script = { chapters: rec.script?.chapters.slice(0, sources.length) ?? [] };
      for (let i = script.chapters.length; i < sources.length; i++) {
        const source = sources[i];
        if (!source) continue;
        const paragraphs: string[] = [];
        for (const chunk of cut(`${source.title}\n\n${source.text}`, MAX_SCRIPT_CHUNK)) {
          const raw = await chatJson(key, model, [{ role: "system", content: VERBATIM_PROMPT }, { role: "user", content: chunk }], VERBATIM_FORMAT, { feature: "audio_script" });
          paragraphs.push(...parseSpoken(raw));
        }
        script.chapters.push({ title: source.title, paragraphs: passages(paragraphs) });
        await saveScript(id, script, (i + 1) / sources.length);
      }
    }
    await execute(`UPDATE recordings SET status = 'speaking', progress = 0, updated_at = $2 WHERE id = $1`, [id, nowIso()]);
    notifyTablesChanged(["recordings"]);
    await invoke("audio_render", { id });
    notifyTablesChanged(AUDIO_TABLES);
  } catch (e) {
    work.failed(e);
    await fail(id, errorMessage(e));
  } finally {
    work.done();
    writing.delete(id);
  }
}

// Spec: AUD-6
/** Tries a recording that failed again, from where it stopped. */
export async function retryRecording(rec: Recording): Promise<void> {
  const total = rec.script?.chapters.length ?? 0;
  const scripted = rec.kind === "summary" ? total > 0 : total > 0 && rec.progress >= 1;
  if (scripted && rec.error !== null && !rec.error.includes("script")) {
    await execute(`UPDATE recordings SET status = 'speaking', error = NULL, updated_at = $2 WHERE id = $1`, [rec.id, nowIso()]);
    notifyTablesChanged(["recordings"]);
    note("info", "audio", `Trying “${rec.title}” again, from what was already spoken`);
    await invoke("audio_render", { id: rec.id });
  } else {
    await writeScript(rec.id);
  }
}

// Spec: APP-12
export async function removeRecording(id: string): Promise<void> {
  await execute(`DELETE FROM recording_files WHERE recording_id = $1`, [id]);
  await execute(`DELETE FROM listening WHERE recording_id = $1`, [id]);
  await execute(`DELETE FROM recordings WHERE id = $1`, [id]);
  notifyTablesChanged(AUDIO_TABLES);
}

// Spec: AUD-7
/** Whether this device has the recording's audio (it may still be on its way). */
export async function hasAudio(id: string): Promise<boolean> {
  return (await select(`SELECT 1 AS one FROM recording_files WHERE recording_id = $1`, [id])).length > 0;
}

export async function recordingAudio(id: string): Promise<Uint8Array> {
  return bytesOf(z.string().parse(await invoke("audio_read", { id })));
}

// Spec: AUD-9
export async function getListening(id: string): Promise<number | null> {
  const [row] = await select(`SELECT position FROM listening WHERE recording_id = $1`, [id]);
  const p = row?.["position"];
  return typeof p === "number" ? p : null;
}

export async function saveListening(id: string, position: number): Promise<void> {
  await execute(
    `INSERT INTO listening (recording_id, position, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (recording_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
    [id, position, nowIso()],
  );
}

/** On start: this device's recordings that were being written carry on (Rust carries on with those being spoken). */
export async function resumeRecordings(): Promise<void> {
  const me = await myDevice();
  for (const r of await listRecordings()) if (r.status === "writing" && r.device === me) void writeScript(r.id);
}

/** Progress from Rust refreshes what shows recordings. */
export function followAudio(): void {
  const refresh = (payload: unknown) => {
    if (AudioEventSchema.safeParse(payload).success) notifyTablesChanged(["recordings", "recording_files"]);
  };
  void listen("audio-progress", (e) => refresh(e.payload)).catch(() => undefined);
  void listen("audio-changed", (e) => refresh(e.payload)).catch(() => undefined);
}

/** An item's sections a recording can cover, as the record dialog offers them. */
export async function recordableSections(item: LibraryItem): Promise<{ key: string; title: string; depth: number }[]> {
  const html = await readHtml(item.id);
  if (html !== null) {
    const { sanitizePaper, sectionsOf } = await import("./paperHtml");
    const toc = sectionsOf(new DOMParser().parseFromString(sanitizePaper(html), "text/html").body);
    return flatten(toc).flatMap((f) => (f.entry.anchor ? [{ key: `html:${f.entry.anchor}`, title: f.entry.title, depth: f.depth }] : []));
  }
  return flatten(item.toc ?? [])
    .filter((f) => f.entry.page !== null)
    .map((f, i) => ({ key: `toc:${i}`, title: f.entry.title, depth: f.depth }));
}
