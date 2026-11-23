import { useEffect, useMemo, useRef } from "react";
import type { TocEntry } from "../lib/schemas";

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

// Spec: LIB-15
/** A PDF's table of contents: the entry being read marked, an entry chosen goes to its page. */
export function Contents(props: { toc: readonly TocEntry[]; page: number; onPick: (page: number) => void }) {
  const flat = useMemo(() => flatten(props.toc), [props.toc]);
  const active = currentEntry(props.toc, props.page);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current?.querySelector(".toc-entry.active");
    if (el instanceof HTMLElement) el.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <ol className="toc" ref={list}>
      {flat.map((f) => (
        <li key={f.index}>
          <button
            type="button"
            className={f.index === active ? "toc-entry active" : "toc-entry"}
            style={{ paddingLeft: 10 + f.depth * 14 }}
            disabled={f.entry.page === null}
            onClick={() => {
              if (f.entry.page !== null) props.onPick(f.entry.page);
            }}
          >
            <span className="toc-title">{f.entry.title}</span>
            {f.entry.page !== null ? <span className="toc-page">{f.entry.page}</span> : null}
          </button>
        </li>
      ))}
    </ol>
  );
}
