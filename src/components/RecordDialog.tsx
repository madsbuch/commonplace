import { useEffect, useState } from "react";
import { getVoice, recordableSections, recordVerbatim } from "../lib/audio";
import type { LibraryItem } from "../lib/library";
import { go } from "../lib/navigation";

// Spec: AUD-2
/** Recording an item verbatim: the whole of it, or one of its sections and those within it. */
export function RecordDialog(props: { item: LibraryItem; onClose: () => void }) {
  const [sections, setSections] = useState<{ key: string; title: string; depth: number }[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [voice, setVoice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void recordableSections(props.item).then(setSections);
    void getVoice().then(setVoice);
  }, [props.item]);
  const section = sections?.find((s) => s.key === chosen) ?? null;
  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-label="Record aloud" onClick={(e) => e.stopPropagation()}>
        <h2>Record aloud</h2>
        <label className="record-field">
          <span>What to read</span>
          <select value={chosen} onChange={(e) => setChosen(e.target.value)} aria-label="What to read">
            <option value="">The whole {props.item.kind === "book" ? "book" : "paper"}</option>
            {(sections ?? []).map((s) => (
              <option key={s.key} value={s.key}>
                {" ".repeat(s.depth)}
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <p className="muted record-voice">Read by {voice || "…"}</p>
        {problem ? <p className="ai-error">{problem}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() =>
              void recordVerbatim(props.item.id, section ? { key: section.key, title: section.title } : null)
                .then((id) => go(`/audio/${id}`))
                .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
            }
          >
            Record
          </button>
        </div>
      </div>
    </div>
  );
}
