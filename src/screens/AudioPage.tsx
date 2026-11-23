import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { InfoButton } from "../components/InfoButton";
import { AUDIO_TABLES, listRecordings, recordSummary } from "../lib/audio";
import { clock, SUMMARY_MINUTES } from "../lib/audioModel";
import { LIBRARY_TABLES, listItems, type LibraryItem } from "../lib/library";
import { useTablesVersion } from "../lib/live";
import type { Recording } from "../lib/schemas";

/** "Writing the script, 40%" and the like: how a recording stands. */
export function recordingState(r: Recording): string {
  const pct = `${Math.round(r.progress * 100)}%`;
  if (r.status === "writing") return `Writing the script, ${pct}`;
  if (r.status === "speaking") return `Speaking, ${pct}`;
  if (r.status === "failed") return "Couldn't be made";
  return r.durationSeconds ? clock(r.durationSeconds) : "Ready";
}

// Spec: AUD-4
function SummarizeDialog(props: { onClose: () => void }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [minutes, setMinutes] = useState<number>(SUMMARY_MINUTES[1]);
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void listItems().then(setItems);
  }, []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => q === "" || `${i.title} ${i.authors}`.toLowerCase().includes(q));
  }, [items, query]);
  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog summarize-dialog" role="dialog" aria-label="Summarize papers" onClick={(e) => e.stopPropagation()}>
        <h2>Summarize papers</h2>
        <input className="library-search" placeholder="Search the library" value={query} onChange={(e) => setQuery(e.target.value)} />
        <ul className="summarize-items">
          {shown.map((i) => (
            <li key={i.id}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.includes(i.id)}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, i.id] : c.filter((x) => x !== i.id)))}
                />
                <span>{i.title}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="segmented" role="radiogroup" aria-label="Length">
          {SUMMARY_MINUTES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={minutes === m} onClick={() => setMinutes(m)}>
              {m} min
            </button>
          ))}
        </div>
        {problem ? <p className="ai-error">{problem}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={chosen.length === 0}
            onClick={() =>
              void recordSummary(chosen, minutes)
                .then((id) => navigate(`/audio/${id}`))
                .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
            }
          >
            Record summary
          </button>
        </div>
      </div>
    </div>
  );
}

// Spec: AUD-1, APP-12
/** The audio library: every recording, newest first. Deleting is on a recording's own screen. */
export default function AudioPage() {
  const version = useTablesVersion([...AUDIO_TABLES, ...LIBRARY_TABLES]);
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  useEffect(() => {
    let live = true;
    void listRecordings().then((r) => {
      if (live) setRecordings(r);
    });
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <div className="screen">
      <div className="library-head">
        <div className="with-info">
          <h1>Audio</h1>
          {/* Spec: APP-9 */}
          <InfoButton title="The audio library">
            <p>Papers and books read aloud: a whole paper or one of its sections, word for word, with formulas said as a mathematician would say them; or a spoken summary of several.</p>
            <p>Record one from a paper's menu (⋯) in the library. Recordings are made once, on the device you start them on, and sync to your other devices for listening offline.</p>
          </InfoButton>
        </div>
        <button type="button" className="button-primary" onClick={() => setSummarizing(true)}>
          Summarize papers…
        </button>
      </div>
      {recordings && recordings.length === 0 ? <p className="muted">No recordings yet.</p> : null}
      <ul className="library-list">
        {(recordings ?? []).map((r) => (
          <li key={r.id}>
            <Link to={`/audio/${r.id}`} className="library-row">
              <span className="library-title">{r.title}</span>
              <span className="library-meta muted">
                {r.kind === "summary" ? `Summary · ${r.minutes ?? ""} min` : "Read aloud"} · {recordingState(r)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {summarizing ? <SummarizeDialog onClose={() => setSummarizing(false)} /> : null}
    </div>
  );
}
