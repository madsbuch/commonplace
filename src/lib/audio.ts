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
  timeline,
  titleWords,
} from "./audioModel";
import { execute, getSetting, nowIso, select, setSetting } from "./db";
import { derivedId, newId } from "./ids";
import { bytesOf, getItem, hasHtml, readFile, readHtml, type LibraryItem } from "./library";
import { notifyTablesChanged } from "./live";
import { chatJson, errorMessage } from "./openrouter";
import { AudioEventSchema, ListeningRowSchema, parseRecording, PieceRowSchema, type Provenance, type Recording, type Script, type TocEntry } from "./schemas";
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

/** Adds a recording (unless it's there: an item's reading may be started on two devices at once). */
async function create(id: string, kind: "verbatim" | "summary", title: string, items: string[], minutes: number | null, voice?: string): Promise<void> {
  const at = nowIso();
  await execute(
    `INSERT OR IGNORE INTO recordings (id, kind, title, items, section, minutes, voice, speech_model, status, progress, device, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 'writing', 0, $8, $9, $9)`,
    [id, kind, title, JSON.stringify(items), minutes, voice ?? (await getVoice()), await getSpeechModel(), await myDevice(), at],
  );
  notifyTablesChanged(AUDIO_TABLES);
}

// Spec: AUD-2
/** An item's reading's id: derived from the item's, so every device makes the same one. */
export function readingId(itemId: string): Promise<string> {
  return derivedId("recordings", `reading:${itemId}`);
}

/** An item's reading, if it has one. */
export async function getReading(itemId: string): Promise<Recording | null> {
  return getRecording(await readingId(itemId));
}

// Spec: AUD-2, AUD-15
/**
 * An item's reading, started if it has none (in `voice`, else the voice
 * chosen in Settings), its script prepared. Returns its id.
 */
export async function startReading(itemId: string, voice?: string): Promise<string> {
  const item = await getItem(itemId);
  if (!item) throw new Error("No such item in the library.");
  const id = await readingId(itemId);
  if (!(await getRecording(id))) await create(id, "verbatim", item.title, [itemId], null, voice);
  const rec = await getRecording(id);
  if (rec && rec.script === null) await prepareScript(id);
  else if (rec?.status === "writing") await preparing.get(id);
  else await refreshReading(id).catch((e: unknown) => note("warning", "audio", `Preparing a reading again failed: ${errorMessage(e)}`));
  return id;
}

/**
 * A reading's script from its item's sections, cut into chunks for the
 * script model; a chunk `before` has written already (the same source) keeps
 * what was written, and the model that wrote it.
 */
function scriptOf(sources: readonly SourceChapter[], before: Script | null): Script {
  const written = new Map<string, { passages: string[]; model?: string }>();
  for (const ch of before?.chapters ?? []) {
    for (const k of ch.chunks ?? []) if (k.source !== undefined && k.passages) written.set(k.source, { passages: k.passages, ...(k.model ? { model: k.model } : {}) });
  }
  return {
    chapters: sources.map((s) => ({
      title: s.title,
      key: s.key,
      chunks: cut(`${s.title}\n\n${s.text}`, MAX_SCRIPT_CHUNK).map((source) => {
        const w = written.get(source);
        return { source, passages: w?.passages ?? null, ...(w?.model ? { model: w.model } : {}) };
      }),
    })),
  };
}

// Spec: AUD-17
/**
 * Prepares a reading again from its item's text when what it was prepared
 * from has changed (a fresher HTML version, a better way of reading it into
 * chapters); Rust lays the reading over it, keeping what was made of what
 * didn't change. Whether it changed.
 */
export async function refreshReading(id: string): Promise<boolean> {
  const rec = await getRecording(id);
  const itemId = rec?.items[0];
  if (!rec?.script || rec.kind !== "verbatim" || rec.durationSeconds !== null || rec.status === "writing" || !itemId) return false;
  const item = await getItem(itemId);
  if (!item) return false;
  const script = scriptOf((await htmlChapters(item, null)) ?? (await pdfChapters(item, null)), rec.script);
  const shape = (s: Script) => JSON.stringify(s.chapters.map((c) => [c.title, c.key ?? null, (c.chunks ?? []).map((k) => k.source ?? null)]));
  if (shape(script) === shape(rec.script)) return false;
  await invoke("audio_reshape", { id, script: JSON.stringify(script) });
  note("info", "audio", `“${rec.title}” was prepared again from its text`);
  notifyTablesChanged(AUDIO_TABLES);
  return true;
}

// Spec: AUD-18
/** Makes a chapter of a recording (by its place in the script), all of it, now. */
export async function makeChapter(id: string, chapter: number): Promise<void> {
  await invoke("audio_make_chapter", { id, chapter });
  notifyTablesChanged(["recording_pieces", "recordings"]);
}

// Spec: AUD-2
/** Where a section of an item starts in its reading, in seconds, by its key or else its title; null if it isn't one of its chapters. */
export async function sectionStart(id: string, sectionKey: string, title?: string): Promise<number | null> {
  const rec = await getRecording(id);
  if (!rec?.script) return null;
  let c = rec.script.chapters.findIndex((ch) => ch.key === sectionKey);
  if (c < 0 && title !== undefined) c = rec.script.chapters.findIndex((ch) => titleWords(ch.title) === titleWords(title));
  if (c < 0) return null;
  return timeline(id, rec.script, await recordingPieces(id)).slots.find((s) => s.chapter === c)?.start ?? null;
}

// Spec: AUD-15
/** Reads a reading in another voice: what was spoken goes; its prepared text, and where it was left, stay. */
export async function readInVoice(id: string, voice: string): Promise<void> {
  await invoke("audio_forget", { id }).catch(() => undefined);
  await execute(`DELETE FROM recording_pieces WHERE recording_id = $1`, [id]);
  await execute(`UPDATE recordings SET voice = $2, speech_model = $3, status = 'listening', progress = 0, error = NULL, updated_at = $4 WHERE id = $1`, [
    id,
    voice,
    await getSpeechModel(),
    nowIso(),
  ]);
  notifyTablesChanged(AUDIO_TABLES);
}

// Spec: AUD-4
export async function recordSummary(itemIds: string[], minutes: number): Promise<string> {
  const items = (await Promise.all(itemIds.map(getItem))).filter((i): i is LibraryItem => i !== null);
  if (items.length === 0) throw new Error("Choose a paper or book to summarize.");
  const title = items.length === 1 ? `Summary: ${items[0]?.title ?? ""}` : `Summary of ${items.length} works`;
  const id = newId("recordings");
  await create(id, "summary", title, items.map((i) => i.id), minutes);
  void prepareScript(id);
  return id;
}

// ---------------------------------------------------------------------------
// The text to read: an item's sections, from its HTML version or its PDF
// ---------------------------------------------------------------------------

interface SourceChapter {
  title: string;
  text: string;
  /** The item's section it is: `html:<anchor>`, `toc:<i>`, or `front`. */
  key: string;
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

// Spec: AUD-2, AUD-3
/**
 * The sections of an item's HTML version a recording reads, each without
 * the sections within it: a `section` element's own text, or, where the
 * sections are only headings (a blog post, an HTML file), a heading and what
 * follows it up to the next. The front matter comes first, without authors.
 */
async function htmlChapters(item: LibraryItem, section: string | null): Promise<SourceChapter[] | null> {
  const html = await readHtml(item.id);
  if (html === null) return null;
  const { between, hasSections, sanitizePaper, sectionsOf, textOf, withoutAuthors } = await import("./paperHtml");
  const root = new DOMParser().parseFromString(sanitizePaper(html), "text/html").body;
  const flat = flatten(sectionsOf(root));
  const anchor = section?.startsWith("html:") ? section.slice(5) : null;
  const from = anchor === null ? null : flat.findIndex((f) => f.entry.anchor === anchor);
  const sectioned = hasSections(root);
  const at = (f: Flat | undefined): Element | null => (f?.entry.anchor ? root.querySelector(`[id="${CSS.escape(f.entry.anchor)}"]`) : null);
  const chapters: SourceChapter[] = [];
  const own = (f: Flat): string => {
    const el = at(f);
    if (!el) return "";
    if (!sectioned) return textOf(between(root, el, at(flat[flat.indexOf(f) + 1])));
    const copy = el.cloneNode(true);
    if (!(copy instanceof Element)) return "";
    for (const nested of copy.querySelectorAll("section[id]")) nested.remove();
    return textOf(copy);
  };
  if (from === null) {
    // What comes before the first section: the title and the abstract, or a post's opening.
    let front: Element | null = null;
    if (sectioned) {
      const copy = root.cloneNode(true);
      if (copy instanceof Element) {
        for (const s of copy.querySelectorAll("section[id]")) s.remove();
        front = copy;
      }
    } else {
      front = between(root, null, at(flat[0]));
    }
    if (front) {
      // Spec: AUD-3
      withoutAuthors(front);
      const text = textOf(front);
      if (text.trim()) chapters.push({ title: item.title, text, key: "front" });
    }
  }
  for (const f of scope(flat, from === -1 ? null : from)) {
    if (f.entry.anchor && at(f)) chapters.push({ title: f.entry.title, text: own(f), key: `html:${f.entry.anchor}` });
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
  if (flat.length === 0) return [{ title: item.title, text: pages.join("\n\n"), key: "front" }];
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
    if (text.trim()) chapters.push({ title: item.title, text, key: "front" });
  }
  for (const f of chosen) chapters.push({ title: f.entry.title, text: textOf(f), key: `toc:${flat.indexOf(f)}` });
  return chapters;
}

/** An item's whole text, for a summary: its HTML version's, or its PDF's; and which it was. */
async function wholeText(item: LibraryItem, budget: number): Promise<{ text: string; from: "html" | "pdf" }> {
  const html = await readHtml(item.id);
  if (html !== null) {
    const { sanitizePaper, textOf, withoutAuthors } = await import("./paperHtml");
    const body = new DOMParser().parseFromString(sanitizePaper(html), "text/html").body;
    // Spec: AUD-4
    withoutAuthors(body);
    return { text: textOf(body).slice(0, budget), from: "html" };
  }
  return { text: (await pdfChapters(item, null)).map((c) => `${c.title}\n\n${c.text}`).join("\n\n").slice(0, budget), from: "pdf" };
}

// ---------------------------------------------------------------------------
// Preparing the script; then Rust makes it as it's listened to
// ---------------------------------------------------------------------------

/** What a summary can read of its sources in all, in characters. */
const SUMMARY_BUDGET = 90_000;

/** Scripts being prepared, to wait for. */
const preparing = new Map<string, Promise<void>>();

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
export function prepareScript(id: string): Promise<void> {
  const running = preparing.get(id);
  if (running) return running;
  const p = prepare(id).finally(() => preparing.delete(id));
  preparing.set(id, p);
  return p;
}

async function prepare(id: string): Promise<void> {
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
        // Spec: AUD-4
        // What they say, not who wrote them: no authors go to the model.
        const texts = await Promise.all(items.map((i) => wholeText(i, budget)));
        const works = items.map((i, n) => `Work ${n + 1}: "${i.title}"${i.year ? ` (${i.year})` : ""}\n\n${texts[n]?.text ?? ""}`);
        const model = await getScriptModel();
        const instructions = summaryPrompt(rec.minutes ?? 15);
        const raw = await chatJson(key, model, [{ role: "system", content: instructions }, { role: "user", content: works.join("\n\n---\n\n") }], SUMMARY_FORMAT, {
          feature: "audio_script",
        });
        // Spec: AUD-16
        const provenance: Provenance = {
          made: nowIso(),
          device: await myDevice(),
          scriptModel: model,
          instructions,
          minutes: rec.minutes,
          speechModel: rec.speechModel,
          voice: rec.voice,
          sources: items.map((i, n) => ({ itemId: i.id, title: i.title, year: i.year, text: texts[n]?.from ?? "pdf", characters: texts[n]?.text.length ?? 0 })),
        };
        await execute(`UPDATE recordings SET provenance = $2 WHERE id = $1`, [id, JSON.stringify(provenance)]);
        const summary = parseSummary(raw);
        if (summary.chapters.length === 0) throw new Error("The script model wrote nothing to read.");
        script = { chapters: summary.chapters.map((c) => ({ title: c.title, chunks: [{ passages: passages(c.paragraphs) }] })) };
        if (summary.title) await execute(`UPDATE recordings SET title = $2 WHERE id = $1`, [id, summary.title]);
      } else {
        const item = items[0];
        if (!item) throw new Error("Its paper is no longer in the library.");
        script = scriptOf((await htmlChapters(item, rec.section)) ?? (await pdfChapters(item, rec.section)), null);
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
  // Pieces kept aside for a chunk to be written again (AUD-17) aren't in its timeline.
  const rows = (await select(`SELECT id, seconds FROM recording_pieces WHERE recording_id = $1 AND chapter >= 0`, [id])).map((r) => PieceRowSchema.parse(r));
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
  const all = await listRecordings();
  for (const r of all) if (r.status === "writing" && r.device === me) void prepareScript(r.id);
  await adoptEarlier(all).catch((e: unknown) => note("warning", "audio", `Taking earlier recordings into their readings failed: ${errorMessage(e)}`));
  // Spec: AUD-17
  // Readings of HTML versions follow their text (reading a PDF again costs more: that's done when one is listened to).
  for (const r of await listRecordings()) {
    const item = r.items[0];
    if (r.kind !== "verbatim" || r.durationSeconds !== null || !item || !(await hasHtml(item))) continue;
    await refreshReading(r.id).catch((e: unknown) => note("warning", "audio", `Preparing “${r.title}” again failed: ${errorMessage(e)}`));
  }
}

// Spec: AUD-14
/**
 * An item's recordings from before it had one reading (a section, the whole
 * of it) become part of its reading, in the voice of the latest of them:
 * what they made is taken in (in Rust), and they go. Recordings made at once
 * as one file stay as they are.
 */
async function adoptEarlier(all: readonly Recording[]): Promise<void> {
  const byItem = new Map<string, Recording[]>();
  for (const r of all) {
    const item = r.items[0];
    if (r.kind !== "verbatim" || r.durationSeconds !== null || r.items.length !== 1 || !item) continue;
    if (r.id === (await readingId(item))) continue;
    byItem.set(item, [...(byItem.get(item) ?? []), r]);
  }
  for (const [item, earlier] of byItem) {
    const latest = earlier.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const reading = await startReading(item, latest.voice).catch(() => null);
    if (!reading) continue;
    await invoke("audio_adopt", { reading, old: earlier.map((r) => r.id) });
    notifyTablesChanged(AUDIO_TABLES);
  }
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
