// ---------------------------------------------------------------------------
// The audio library without I/O: voices, lengths and speeds, passages, the
// sections a verbatim recording leaves out, and the prompts and answers of
// the script model (formulas into speech; summaries). Tested in
// tests/audio.test.ts.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { RecordingChapter, Script } from "./schemas";

// Spec: AUD-5
/** `audio.speech-model` and `audio.voice` in the spec. */
export const DEFAULT_SPEECH_MODEL = "google/gemini-3.1-flash-tts-preview";
export const DEFAULT_VOICE = "Charon";
/** `audio.script-model` in the spec. */
export const DEFAULT_SCRIPT_MODEL = "anthropic/claude-haiku-5.5";

/** The speech model's voices, and what each sounds like. */
export const VOICES: readonly { name: string; character: string }[] = [
  { name: "Charon", character: "informative" },
  { name: "Rasalgethi", character: "informative" },
  { name: "Sadaltager", character: "knowledgeable" },
  { name: "Iapetus", character: "clear" },
  { name: "Erinome", character: "clear" },
  { name: "Schedar", character: "even" },
  { name: "Kore", character: "firm" },
  { name: "Orus", character: "firm" },
  { name: "Alnilam", character: "firm" },
  { name: "Algieba", character: "smooth" },
  { name: "Despina", character: "smooth" },
  { name: "Gacrux", character: "mature" },
  { name: "Sulafat", character: "warm" },
  { name: "Vindemiatrix", character: "gentle" },
  { name: "Achernar", character: "soft" },
  { name: "Achird", character: "friendly" },
  { name: "Umbriel", character: "easy-going" },
  { name: "Callirrhoe", character: "easy-going" },
  { name: "Zubenelgenubi", character: "casual" },
  { name: "Aoede", character: "breezy" },
  { name: "Enceladus", character: "breathy" },
  { name: "Algenib", character: "gravelly" },
  { name: "Pulcherrima", character: "forward" },
  { name: "Zephyr", character: "bright" },
  { name: "Autonoe", character: "bright" },
  { name: "Puck", character: "upbeat" },
  { name: "Laomedeia", character: "upbeat" },
  { name: "Leda", character: "youthful" },
  { name: "Sadachbia", character: "lively" },
  { name: "Fenrir", character: "excitable" },
];

// Spec: AUD-4
/** `audio.summary-lengths` in the spec, in minutes. */
export const SUMMARY_MINUTES = [5, 15, 30] as const;
/** How fast the narrator reads, for a summary's length in words. */
export const WORDS_PER_MINUTE = 150;

// Spec: AUD-8
/** `audio.speeds` in the spec. */
export const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;

/** A passage the speech model is given at once: long enough to sound whole, short enough to come back quickly. */
export const MAX_PASSAGE = 900;
/** Text the script model is given at once. */
export const MAX_SCRIPT_CHUNK = 6000;

/** Text cut where it reads naturally: at paragraphs, then sentences, then words. */
export function cut(text: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (p.length <= max) {
      if (current && current.length + p.length + 2 > max) push();
      current = current ? `${current}\n\n${p}` : p;
      continue;
    }
    push();
    const sentences = p.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) ?? [p];
    for (const s of sentences) {
      if (s.length > max) {
        push();
        for (const w of s.split(" ")) {
          if (current.length + w.length + 1 > max) push();
          current = current ? `${current} ${w}` : w;
        }
        continue;
      }
      if (current.length + s.length > max) push();
      current += s;
    }
    push();
  }
  push();
  return out;
}

/** What the speech model is given: one paragraph at a time, long ones cut at sentences. */
export function passages(paragraphs: readonly string[]): string[] {
  return paragraphs.flatMap((p) => cut(p, MAX_PASSAGE).flatMap((c) => c.split(/\n\n/)));
}

// Spec: AUD-3
/** The sections a verbatim recording of a whole paper leaves out. */
export function isBibliography(title: string): boolean {
  return /^(?:[\dA-Z.]+\s+)?(references|bibliography|works cited|literature cited|citations)\s*$/i.test(title.trim());
}

// Spec: AUD-4
export function summaryPrompt(minutes: number): string {
  const words = minutes * WORDS_PER_MINUTE;
  return `You write a spoken summary of the papers or books you're given, read by one narrator to a listener who knows the field and wants to know what these works say before reading them.

- About ${words} words in all (${minutes} minutes read aloud). Spend them on what matters: the question, the ideas, the main results and how they're reached, and how the works relate to each other.
- Written to be heard: plain sentences, no lists, no headings read out, no visual references ("as shown in the figure"). Formulas said the way a mathematician reads them aloud, and only where they help.
- What the works say, never who wrote them: name a work by its title, and never its authors, their institutions or anyone's role in writing it.
- In parts of a few paragraphs each, each with a short title: these are the recording's chapters. Begin with what the recording is about.`;
}

export const SUMMARY_FORMAT = {
  name: "spoken_summary",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "parts"],
    properties: {
      title: { type: "string" },
      parts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "paragraphs"],
          properties: { title: { type: "string" }, paragraphs: { type: "array", items: { type: "string" } } },
        },
      },
    },
  },
} as const;

export interface ScriptChapter {
  title: string;
  paragraphs: string[];
}

/** The script model's summary: its title and parts (empty ones dropped). */
export function parseSummary(raw: unknown): { title: string; chapters: ScriptChapter[] } {
  const r = z
    .object({ title: z.coerce.string().default(""), parts: z.array(z.object({ title: z.coerce.string().default(""), paragraphs: z.array(z.coerce.string()).default([]) })).default([]) })
    .safeParse(raw);
  if (!r.success) return { title: "", chapters: [] };
  return {
    title: r.data.title.trim(),
    chapters: r.data.parts
      .map((p) => ({ title: p.title.trim(), paragraphs: p.paragraphs.map((x) => x.trim()).filter((x) => x !== "") }))
      .filter((p) => p.paragraphs.length > 0),
  };
}

/** "12:05", "1:02:09". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The chapter playing at `t` seconds: the last that starts at or before it. */
export function chapterAt(chapters: readonly { start: number }[], t: number): number {
  let at = 0;
  chapters.forEach((c, i) => {
    if (c.start <= t + 0.05) at = i;
  });
  return at;
}

// Spec: AUD-12
/** The moment an address names, `#t=125.5`. */
export function timeOfFragment(hash: string): number | null {
  const m = /^#?t=(\d+(?:\.\d+)?)$/.exec(hash);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// A recording made as it's listened to: its timeline
// ---------------------------------------------------------------------------

// Spec: AUD-6
/** How fast a passage is read before any is made, in characters a second (as Rust's `CHARS_PER_SECOND`). */
export const CHARS_PER_SECOND = 15;

/** A place in a recording: a passage (made or not), or a chunk of its script not yet written. */
export interface Slot {
  /** The piece's id, `<recording>.<chapter>.<chunk>.<passage>`; for a chunk not yet written, its first passage's. */
  id: string;
  chapter: number;
  chunk: number;
  /** Null for a chunk not yet written. */
  passage: number | null;
  /** When it starts, in seconds: what's made counts as it is, the rest as it will likely be. */
  start: number;
  seconds: number;
  made: boolean;
}

export interface Timeline {
  slots: Slot[];
  chapters: RecordingChapter[];
  /** For each of `chapters`: the script's chapter it is, and how much of it is made, 0 to 1 (AUD-18). */
  made: { chapter: number; made: number }[];
  /** The whole length, as likely as it can be said. */
  duration: number;
  /** How much of it is made. */
  madeSeconds: number;
}

/** A script's chunks, a chapter's; a chapter of a recording made before is one, written. */
export function chunksOf(chapter: Script["chapters"][number]): { source?: string; passages: string[] | null }[] {
  return chapter.chunks ?? (chapter.paragraphs ? [{ passages: chapter.paragraphs }] : []);
}

export function pieceId(recordingId: string, chapter: number, chunk: number, passage: number): string {
  return `${recordingId}.${chapter}.${chunk}.${passage}`;
}

// Spec: AUD-6, AUD-8
/**
 * Where everything in a recording is, given which pieces are made (`made`:
 * id → seconds). A passage not yet made, or a chunk not yet written, takes
 * as long as its text at the pace of what's made (or `CHARS_PER_SECOND`).
 */
export function timeline(recordingId: string, script: Script, made: ReadonlyMap<string, number>): Timeline {
  const places: { id: string; chapter: number; chunk: number; passage: number | null; chars: number }[] = [];
  script.chapters.forEach((ch, c) =>
    chunksOf(ch).forEach((k, i) => {
      if (k.passages === null) {
        places.push({ id: pieceId(recordingId, c, i, 0), chapter: c, chunk: i, passage: null, chars: k.source?.length ?? 0 });
        return;
      }
      k.passages.forEach((text, p) => {
        if (text.trim() !== "") places.push({ id: pieceId(recordingId, c, i, p), chapter: c, chunk: i, passage: p, chars: text.length });
      });
    }),
  );
  let chars = 0;
  let secs = 0;
  for (const p of places) {
    const s = p.passage === null ? undefined : made.get(p.id);
    if (s !== undefined) {
      chars += p.chars;
      secs += s;
    }
  }
  const pace = chars > 0 && secs > 1 ? chars / secs : CHARS_PER_SECOND;
  const slots: Slot[] = [];
  let at = 0;
  let madeSeconds = 0;
  for (const p of places) {
    const s = p.passage === null ? undefined : made.get(p.id);
    const seconds = s ?? p.chars / pace;
    slots.push({ id: p.id, chapter: p.chapter, chunk: p.chunk, passage: p.passage, start: at, seconds, made: s !== undefined });
    if (s !== undefined) madeSeconds += s;
    at += seconds;
  }
  const chapters = script.chapters.flatMap((ch, c) => {
    const first = slots.find((s) => s.chapter === c);
    return first ? [{ title: ch.title, start: first.start }] : [];
  });
  // Spec: AUD-18
  const madeOf = script.chapters.flatMap((_, c) => {
    const own = slots.filter((s) => s.chapter === c);
    if (own.length === 0) return [];
    const all = own.reduce((n, s) => n + s.seconds, 0);
    const done = own.reduce((n, s) => n + (s.made ? s.seconds : 0), 0);
    return [{ chapter: c, made: own.every((s) => s.made) ? 1 : all > 0 ? Math.min(0.99, done / all) : 0 }];
  });
  return { slots, chapters, made: madeOf, duration: at, madeSeconds };
}

/** The slot playing at `t` seconds, and how far into it: the last that starts at or before it. */
export function slotAt(tl: Timeline, t: number): { index: number; offset: number } | null {
  if (tl.slots.length === 0) return null;
  let index = 0;
  tl.slots.forEach((s, i) => {
    if (s.start <= t + 0.001) index = i;
  });
  const slot = tl.slots[index];
  return slot ? { index, offset: Math.max(0, Math.min(t - slot.start, slot.seconds)) } : null;
}

/** When a piece starts in the recording, if it's in it. */
export function startOf(tl: Timeline, id: string): number | null {
  return tl.slots.find((s) => s.id === id)?.start ?? null;
}
