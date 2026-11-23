// ---------------------------------------------------------------------------
// The audio library without I/O: voices, lengths and speeds, passages, the
// sections a verbatim recording leaves out, and the prompts and answers of
// the script model (formulas into speech; summaries). Tested in
// tests/audio.test.ts.
// ---------------------------------------------------------------------------

import { z } from "zod";

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

// Spec: AUD-3
export const VERBATIM_PROMPT = `You prepare a passage of a scientific paper or book for reading aloud to a listener, word for word.

- Keep every word of the prose exactly as written, in its order. Don't summarize, explain, shorten or add anything.
- Say each formula the way a mathematician reads it aloud: "x squared plus y", "the sum over i from 1 to n of a sub i", "f of x", "for all x in A". Maths may be given as LaTeX between $ signs, or garbled by extraction from a PDF; read what it means. Keep a formula's number only if the text refers to it.
- Drop what isn't read aloud: the authors' names, their institutions, emails and footnotes about them; page numbers, running heads, footnote marks, numeric citation marks like [12], URLs, and hyphens that only split a word across lines.
- Read figure and table captions. Leave out the body of a table and an algorithm's code, saying in a few words what it shows.
- Split the passage into paragraphs as written.`;

export const VERBATIM_FORMAT = {
  name: "spoken_passage",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["paragraphs"],
    properties: { paragraphs: { type: "array", items: { type: "string" } } },
  },
} as const;

/** The script model's answer for a verbatim passage: its paragraphs, to be read. */
export function parseSpoken(raw: unknown): string[] {
  const r = z.object({ paragraphs: z.array(z.coerce.string()) }).safeParse(raw);
  return r.success ? r.data.paragraphs.map((p) => p.trim()).filter((p) => p !== "") : [];
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
