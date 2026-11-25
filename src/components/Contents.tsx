import { useEffect, useMemo, useRef } from "react";
import { clock, type ListenEntry } from "../lib/audioModel";
import type { TocEntry } from "../lib/schemas";
import { ListenIcon } from "./Icons";
import { MadeRing } from "./MadeRing";

interface Flat {
  entry: TocEntry;
  depth: number;
  index: number;
}

function flatten(entries: readonly TocEntry[], depth = 0, out: Flat[] = []): Flat[] {
  for (const entry of entries) {
    out.push({ entry, depth, index: out.length });
    flatten(entry.children, depth + 1, out);
  }
  return out;
}

/** The entry being read: the last one, in reading order, that starts at or before `page`. */
export function currentEntry(entries: readonly TocEntry[], page: number): number | null {
  let found: number | null = null;
  for (const f of flatten(entries)) if (f.entry.page !== null && f.entry.page <= page) found = f.index;
  return found;
}

/** Listening from the contents (AUD-2, AUD-18, AUD-19): what each entry is in the item's reading, and what to do. */
export interface ContentsListening {
  /** For each entry, in reading order: what it is in the reading, or null where it isn't read aloud. */
  entries: readonly (ListenEntry | null)[];
  /** What comes before the first section, as a row of its own; null when there's none. */
  beginning: ListenEntry | null;
  /** The section being heard, by its key. */
  hearing: string | null;
  /** A section whose listening is being started. */
  busy: string | null;
  /** Whether the section being heard waits for its part to be made. */
  waiting?: boolean;
  /** Sections asked to be made now. */
  making: ReadonlySet<string>;
  /** Listens from a section (where the contents sit beside what's read). */
  onListen?: (key: string, title: string) => void;
  onMake: (key: string, title: string) => void;
  /** Goes to the beginning. */
  onBeginning: () => void;
  /** Where each section starts in the reading, in seconds, shown in place of pages (on the player). */
  times?: ReadonlyMap<string, number>;
}

/** A row's listening: its made ring and its ▶. */
function ListenControls(props: { listen: ContentsListening; at: ListenEntry; title: string }) {
  const { listen, at, title } = props;
  // Spec: AUD-20
  // Getting ready, or waiting for its part to be made: a spinner in place of its ▶ until it plays.
  const waiting = listen.hearing === at.key && listen.waiting === true;
  const busy = listen.busy === at.key || waiting;
  return (
    <>
      <MadeRing title={title} made={at.made} making={listen.making.has(at.key) || waiting} onMake={() => listen.onMake(at.key, title)} />
      {listen.onListen ? (
        <button
          type="button"
          className={busy ? "toc-listen busy" : "toc-listen"}
          aria-label={busy ? `Getting “${title}” ready` : `Listen from “${title}”`}
          aria-busy={busy}
          title={waiting ? "Making this part…" : "Listen from here"}
          disabled={listen.busy !== null}
          onClick={() => listen.onListen?.(at.key, title)}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : <ListenIcon />}
        </button>
      ) : null}
    </>
  );
}

// Spec: LIB-15, LIB-25, AUD-2, AUD-18, AUD-19
/**
 * A table of contents: the entry being read marked (by the PDF page in view,
 * or the HTML section), an entry chosen goes to its page or section. With
 * `listen`, each section read aloud shows how much of it is made (pressed
 * to make it now) and can be listened from, the one being heard is marked,
 * and the beginning has a row of its own.
 */
export function Contents(props: {
  toc: readonly TocEntry[];
  page?: number;
  anchor?: string | null;
  onPick: (entry: TocEntry, listen: ListenEntry | null) => void;
  listen?: ContentsListening;
}) {
  const flat = useMemo(() => flatten(props.toc), [props.toc]);
  const active = props.anchor !== undefined ? (flat.find((f) => f.entry.anchor === props.anchor)?.index ?? null) : currentEntry(props.toc, props.page ?? 1);
  const list = useRef<HTMLOListElement>(null);
  const listen = props.listen;
  useEffect(() => {
    const el = list.current?.querySelector(".toc-entry.active");
    if (el instanceof HTMLElement) el.scrollIntoView({ block: "nearest" });
  }, [active]);
  const time = (at: ListenEntry | null | undefined) => {
    const t = at ? listen?.times?.get(at.key) : undefined;
    return t === undefined ? null : <span className="toc-page">{clock(t)}</span>;
  };
  const begin = listen?.beginning ?? null;
  return (
    <ol className="toc" ref={list}>
      {listen && begin ? (
        <li className={listen.hearing === begin.key ? "toc-row hearing" : "toc-row"}>
          <button type="button" className="toc-entry" onClick={listen.onBeginning} {...(listen.hearing === begin.key ? { "aria-current": "true" as const } : {})}>
            <span className="toc-title">Beginning</span>
            {time(begin)}
          </button>
          <ListenControls listen={listen} at={begin} title="Beginning" />
        </li>
      ) : null}
      {flat.map((f) => {
        const at = listen?.entries[f.index] ?? null;
        const hearing = at !== null && listen?.hearing === at.key;
        return (
          <li key={f.index} className={hearing ? "toc-row hearing" : "toc-row"}>
            <button
              type="button"
              className={f.index === active ? "toc-entry active" : "toc-entry"}
              style={{ paddingLeft: 10 + f.depth * 14 }}
              // On the player, a section not read aloud leads nowhere.
              disabled={listen?.times ? !at : f.entry.page === null && !f.entry.anchor}
              onClick={() => props.onPick(f.entry, at)}
              {...(hearing ? { "aria-current": "true" as const } : {})}
            >
              <span className="toc-title">{f.entry.title}</span>
              {listen?.times ? time(at) : f.entry.page !== null ? <span className="toc-page">{f.entry.page}</span> : null}
            </button>
            {listen && at ? <ListenControls listen={listen} at={at} title={f.entry.title} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
