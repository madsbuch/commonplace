// ---------------------------------------------------------------------------
// The audio library's I/O (AUD-1 to AUD-13): preparing a recording's script
// here (a paper's text by its sections, cut into chunks for the script model;
// or a summary of several papers, written whole), then Rust makes it as it's
// listened to (src-tauri/src/audio/render.rs): each chunk written when it's
// reached, each passage spoken into a piece of its own, `audio.lead` ahead of
// the listener; or all of it at once when asked (AUD-13).
// ---------------------------------------------------------------------------

import { note } from "./diagnostics";
import { asWork } from "./work";
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
  parseSummary,
  passages,
  summaryPrompt,
  SUMMARY_FORMAT,
} from "./audioModel";
import { execute, getSetting, nowIso, select, setSetting } from "./db";
import { newId } from "./ids";
import { bytesOf, getItem, readFile, readHtml, type LibraryItem } from "./library";
import { notifyTablesChanged } from "./live";
import { chatJson, errorMessage } from "./openrouter";
import { AudioEventSchema, ListeningRowSchema, parseRecording, PieceRowSchema, type Recording, type Script, type TocEntry } from "./schemas";
import { getSyncStatus } from "./sync";

export const AUDIO_TABLES = ["recordings", "recording_pieces", "recording_files", "listening"];

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
  void prepareScript(id);
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
  const { sanitizePaper, sectionsOf, textOf, withoutAuthors } = await import("./paperHtml");
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
    // What comes before the first section: the title and the abstract.
    const front = root.cloneNode(true);
    if (front instanceof Element) {
      for (const s of front.querySelectorAll("section[id]")) s.remove();
      // Spec: AUD-3
      withoutAuthors(front);
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
    const { sanitizePaper, textOf, withoutAuthors } = await import("./paperHtml");
    const body = new DOMParser().parseFromString(sanitizePaper(html), "text/html").body;
    // Spec: AUD-4
    withoutAuthors(body);
    return textOf(body).slice(0, budget);
  }
  return (await pdfChapters(item, null)).map((c) => `${c.title}\n\n${c.text}`).join("\n\n").slice(0, budget);
}

// ---------------------------------------------------------------------------
// Preparing the script; then Rust makes it as it's listened to
// ---------------------------------------------------------------------------

/** What a summary can read of its sources in all, in characters. */
const SUMMARY_BUDGET = 90_000;

const preparing = new Set<string>();

async function fail(id: string, message: string): Promise<void> {
  await execute(`UPDATE recordings SET status = 'failed', error = $2, updated_at = $3 WHERE id = $1`, [id, message, nowIso()]);
  notifyTablesChanged(["recordings"]);
}

// Spec: AUD-3, AUD-4, AUD-6
/**
 * Prepares a recording's script: a verbatim recording's text, by its
 * sections, cut into chunks the script model writes as they're reached (in
 * Rust); a summary written whole, here. Then it's made as it's listened to.
 */
export async function prepareScript(id: string): Promise<void> {
  if (preparing.has(id)) return;
  preparing.add(id);
  try {
    const rec = await getRecording(id);
    if (!rec) return;
    // Spec: WORK-1, DIAG-1
    await asWork("audio", `Writing the script for “${rec.title}”`, async () => {
      const items = (await Promise.all(rec.items.map(getItem))).filter((i): i is LibraryItem => i !== null);
      if (items.length === 0) throw new Error("Its papers are no longer in the library.");
      await execute(`UPDATE recordings SET status = 'writing', error = NULL, updated_at = $2 WHERE id = $1`, [id, nowIso()]);
      let script: Script;
      if (rec.kind === "summary") {
        const key = await getApiKey();
        if (!key) throw new Error("There's no OpenRouter key (Settings → AI and models).");
        const budget = Math.floor(SUMMARY_BUDGET / items.length);
        const works = await Promise.all(
          // Spec: AUD-4
          // What they say, not who wrote them: no authors go to the model.
          items.map(async (i, n) => `Work ${n + 1}: "${i.title}"${i.year ? ` (${i.year})` : ""}\n\n${await wholeText(i, budget)}`),
        );
        const raw = await chatJson(key, await getScriptModel(), [{ role: "system", content: summaryPrompt(rec.minutes ?? 15) }, { role: "user", content: works.join("\n\n---\n\n") }], SUMMARY_FORMAT, {
          feature: "audio_script",
        });
        const summary = parseSummary(raw);
        if (summary.chapters.length === 0) throw new Error("The script model wrote nothing to read.");
        script = { chapters: summary.chapters.map((c) => ({ title: c.title, chunks: [{ passages: passages(c.paragraphs) }] })) };
        if (summary.title) await execute(`UPDATE recordings SET title = $2 WHERE id = $1`, [id, summary.title]);
      } else {
        const item = items[0];
        if (!item) throw new Error("Its paper is no longer in the library.");
        const sources = (await htmlChapters(item, rec.section)) ?? (await pdfChapters(item, rec.section));
        script = {
          chapters: sources.map((s) => ({ title: s.title, chunks: cut(`${s.title}\n\n${s.text}`, MAX_SCRIPT_CHUNK).map((source) => ({ source, passages: null })) })),
        };
        if (script.chapters.every((c) => (c.chunks ?? []).length === 0)) throw new Error("There's no text to read in it.");
      }
      await execute(`UPDATE recordings SET script = $2, status = 'listening', progress = 0, updated_at = $3 WHERE id = $1`, [id, JSON.stringify(script), nowIso()]);
      notifyTablesChanged(["recordings"]);
    });
  } catch (e) {
    await fail(id, errorMessage(e));
  } finally {
    preparing.delete(id);
  }
}

// Spec: AUD-6
/** The listener is at `piece` of a recording (its start when null): Rust makes `audio.lead` ahead of there. */
export function listenAt(id: string, piece: string | null): void {
  void invoke("audio_listen", { id, piece })
    // What's made arrives as `audio-piece`; anything made before the answer is looked for now.
    .then(() => notifyTablesChanged(["recording_pieces"]))
    .catch((e: unknown) => note("warning", "audio", `Couldn't ask for a recording to be made ahead: ${errorMessage(e)}`));
}

// Spec: AUD-13
/** Makes the rest of a recording at once, on this device. */
export async function makeAll(id: string): Promise<void> {
  await invoke("audio_make_all", { id });
  notifyTablesChanged(["recordings"]);
}

// Spec: AUD-6
/** Tries a recording that failed again: its script, if that's what failed; else what was being made. */
export async function retryRecording(rec: Recording): Promise<void> {
  if (rec.script === null) return prepareScript(rec.id);
  note("info", "audio", `Trying “${rec.title}” again, from what was already made`);
  if (rec.status === "failed") return makeAll(rec.id);
  listenAt(rec.id, null);
}

// Spec: APP-12
export async function removeRecording(id: string): Promise<void> {
  await invoke("audio_forget", { id }).catch(() => undefined);
  await execute(`DELETE FROM recording_pieces WHERE recording_id = $1`, [id]);
  await execute(`DELETE FROM recording_files WHERE recording_id = $1`, [id]);
  await execute(`DELETE FROM listening WHERE recording_id = $1`, [id]);
  await execute(`DELETE FROM recordings WHERE id = $1`, [id]);
  notifyTablesChanged(AUDIO_TABLES);
}

// Spec: AUD-7
/** Whether this device has a recording made before as one file (it may still be on its way). */
export async function hasAudio(id: string): Promise<boolean> {
  return (await select(`SELECT 1 AS one FROM recording_files WHERE recording_id = $1`, [id])).length > 0;
}

export async function recordingAudio(id: string): Promise<Uint8Array> {
  return bytesOf(z.string().parse(await invoke("audio_read", { id })));
}

// Spec: AUD-6, AUD-7
/** The pieces of a recording this device has: id → seconds. */
export async function recordingPieces(id: string): Promise<Map<string, number>> {
  const rows = (await select(`SELECT id, seconds FROM recording_pieces WHERE recording_id = $1`, [id])).map((r) => PieceRowSchema.parse(r));
  return new Map(rows.map((r) => [r.id, r.seconds]));
}

/** A piece's audio. */
export async function pieceAudio(pieceId: string): Promise<Uint8Array> {
  return bytesOf(z.string().parse(await invoke("audio_piece", { id: pieceId })));
}

// Spec: AUD-9
/** Where a recording was left: seconds into its piece, or into the recording when it's one file. */
export async function getListening(id: string): Promise<{ position: number; piece: string | null } | null> {
  const [row] = await select(`SELECT position, piece FROM listening WHERE recording_id = $1`, [id]);
  const r = ListeningRowSchema.safeParse(row);
  return r.success ? r.data : null;
}

export async function saveListening(id: string, position: number, piece: string | null): Promise<void> {
  await execute(
    `INSERT INTO listening (recording_id, position, piece, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (recording_id) DO UPDATE SET position = excluded.position, piece = excluded.piece, updated_at = excluded.updated_at`,
    [id, position, piece, nowIso()],
  );
}

/** On start: this device's recordings whose script was being prepared carry on (Rust carries on with those being made at once). */
export async function resumeRecordings(): Promise<void> {
  const me = await myDevice();
  for (const r of await listRecordings()) if (r.status === "writing" && r.device === me) void prepareScript(r.id);
}

/** What Rust makes refreshes what shows recordings. */
export function followAudio(): void {
  const refresh = (payload: unknown) => {
    if (AudioEventSchema.safeParse(payload).success) notifyTablesChanged(["recordings", "recording_pieces", "recording_files"]);
  };
  void listen("audio-progress", (e) => refresh(e.payload)).catch(() => undefined);
  void listen("audio-changed", (e) => refresh(e.payload)).catch(() => undefined);
  void listen("audio-piece", (e) => refresh(e.payload)).catch(() => undefined);
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
