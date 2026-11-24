import { useEffect, useState } from "react";
import { getListening, getReading, getVoice, recordableSections, sectionStart, startReading } from "../lib/audio";
import { KIND_NAMES, type LibraryItem } from "../lib/library";
import { go } from "../lib/navigation";
import { useNotedProblem } from "../lib/diagnostics";
import type { Recording } from "../lib/schemas";

// Spec: AUD-2, AUD-15
/**
 * Listening to an item: its one reading, started where it was left, at its
 * beginning, or at any of its sections (it plays on from there). A reading
 * not yet started begins in the voice chosen in Settings; one started keeps
 * its own.
 */
export function ListenDialog(props: { item: LibraryItem; onClose: () => void }) {
  const [sections, setSections] = useState<{ key: string; title: string; depth: number }[] | null>(null);
  const [reading, setReading] = useState<Recording | null>(null);
  const [left, setLeft] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [voice, setVoice] = useState("");
  const [busy, setBusy] = useState(false);
  // Spec: DIAG-1
  const [problem, setProblem] = useNotedProblem("audio");
  useEffect(() => {
    void recordableSections(props.item).then(setSections);
    void getVoice().then(setVoice);
    void getReading(props.item.id).then(async (r) => {
      setReading(r);
      const l = r ? await getListening(r.id) : null;
      setLeft(l !== null);
      setFrom((f) => f ?? (l !== null ? "left" : "start"));
    });
  }, [props.item]);
  const listen = async () => {
    setBusy(true);
    try {
      const id = await startReading(props.item.id);
      let at: number | null = null;
      if (from === "start") at = 0;
      else if (from && from !== "left") at = await sectionStart(id, from);
      go(`/audio/${id}${at === null ? "" : `#t=${Number(at.toFixed(2))}`}`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-label="Listen" onClick={(e) => e.stopPropagation()}>
        <h2>Listen</h2>
        <label className="record-field">
          <span>Start at</span>
          <select value={from ?? "start"} onChange={(e) => setFrom(e.target.value)} aria-label="Start at">
            {left ? <option value="left">Where you left off</option> : null}
            <option value="start">The beginning of the {KIND_NAMES[props.item.kind].toLowerCase()}</option>
            {(sections ?? []).map((s) => (
              <option key={s.key} value={s.key}>
                {" ".repeat(s.depth)}
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <p className="muted record-voice">Read by {reading?.voice ?? (voice || "…")}</p>
        {problem ? <p className="ai-error">{problem}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="button-primary" disabled={busy} onClick={() => void listen()}>
            {busy ? "Preparing…" : "Listen"}
          </button>
        </div>
      </div>
    </div>
  );
}
