// ---------------------------------------------------------------------------
// Listening to an item from where it's read (AUD-2, AUD-18, AUD-19): its one
// reading started or carried on in the player without leaving the item, at a
// section of its contents, its beginning, or where it was left; and the
// reading as it stands (how much of each chapter is made), kept current for
// the contents to show.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { AUDIO_TABLES, getReading, getRecording, makeChapter, recordingPieces, sectionStart, startReading } from "./audio";
import { timeline } from "./audioModel";
import { getItem, readHtml } from "./library";
import { useTablesVersion } from "./live";
import { load } from "./player";
import type { Recording, TocEntry } from "./schemas";

// Spec: AUD-2
/**
 * Plays an item's reading (started if it has none): from a section (`key`,
 * by its title where the key isn't one of its chapters), from its
 * beginning (`"start"`), or where it was left (null).
 */
export async function listenFrom(itemId: string, from: { key: string; title?: string } | "start" | null): Promise<void> {
  const id = await startReading(itemId);
  const rec = await getRecording(id);
  if (!rec) return;
  let at: number | null = null;
  if (from === "start") at = 0;
  else if (from) at = from.key === "front" ? 0 : await sectionStart(id, from.key, from.title);
  await load(rec, { at, play: true });
}

// Spec: AUD-18
/** Makes a section of an item's reading now (starting the reading if it has none), by its key or else its title. */
export async function makeSection(itemId: string, key: string, title?: string): Promise<void> {
  const id = await startReading(itemId);
  const rec = await getRecording(id);
  const chapters = rec?.script?.chapters ?? [];
  let c = chapters.findIndex((ch) => ch.key === key);
  if (c < 0 && title !== undefined) {
    const { titleWords } = await import("./audioModel");
    c = chapters.findIndex((ch) => titleWords(ch.title) === titleWords(title));
  }
  if (c >= 0) await makeChapter(id, c);
}

/** An item's reading as it stands: the recording (null when it has none) and how much of each chapter is made (index → 0 to 1). */
export interface ReadingState {
  rec: Recording | null;
  made: ReadonlyMap<number, number> | null;
}

// Spec: AUD-18
/** An item's reading, kept current as it's made. */
export function useReading(itemId: string | null): ReadingState {
  const version = useTablesVersion(AUDIO_TABLES);
  const [state, setState] = useState<ReadingState>({ rec: null, made: null });
  useEffect(() => {
    let live = true;
    if (!itemId) return;
    void getReading(itemId).then(async (rec) => {
      if (!rec?.script || rec.durationSeconds !== null) {
        if (live) setState({ rec, made: null });
        return;
      }
      const tl = timeline(rec.id, rec.script, await recordingPieces(rec.id));
      if (live) setState({ rec, made: new Map(tl.made.map((m) => [m.chapter, m.made])) });
    });
    return () => {
      live = false;
    };
  }, [itemId, version]);
  return state;
}

// Spec: AUD-2
/** An item's contents, as its reading's chapters follow them: its HTML version's sections, or its PDF's outline. */
export function useContents(itemId: string | null): TocEntry[] {
  const [toc, setToc] = useState<TocEntry[]>([]);
  useEffect(() => {
    let live = true;
    if (!itemId) return;
    void (async () => {
      const html = await readHtml(itemId);
      if (html !== null) {
        const { readablePaper, sectionsOf } = await import("./paperHtml");
        const sections = sectionsOf(new DOMParser().parseFromString(readablePaper(html), "text/html").body);
        if (live) setToc(sections);
        return;
      }
      const item = await getItem(itemId);
      if (live) setToc(item?.toc ?? []);
    })();
    return () => {
      live = false;
    };
  }, [itemId]);
  return toc;
}
