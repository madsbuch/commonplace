import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { InfoButton } from "../components/InfoButton";
import { MoreMenu } from "../components/MoreMenu";
import { BackToSettings } from "../components/SettingsRows";
import { useQueryParam } from "../lib/address";
import { emptyDiagnostics, failuresSince, flush, loadDiagnostics, messageOf, type DiagnosticEntry } from "../lib/diagnostics";
import { entryText, lasting } from "../lib/diagnosticsModel";
import { diagnosticsReport } from "../lib/diagnosticsReport";
import { useTablesVersion } from "../lib/live";
import { runningWork, type RunningWork } from "../lib/work";
import "./AiScreens.css";

/** Entries shown at once; the copy has them all. */
const SHOWN = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

// Spec: DIAG-3, DIAG-4, DIAG-6
/** Settings → Diagnostics: the work running now, what happened on this device, and a copy of all of it. */
export default function DiagnosticsPage() {
  const [show, setShow] = useQueryParam("show");
  const failuresOnly = show === "failures";
  const version = useTablesVersion(["diagnostics"]);
  const [entries, setEntries] = useState<DiagnosticEntry[] | null>(null);
  const [failures, setFailures] = useState<number | null>(null);
  const [running, setRunning] = useState<RunningWork[]>([]);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([loadDiagnostics({ failuresOnly, limit: SHOWN }), failuresSince(Date.now() - DAY_MS)]).then(([e, f]) => {
      if (!live) return;
      setEntries(e);
      setFailures(f);
    });
    return () => {
      live = false;
    };
  }, [version, failuresOnly]);

  // What runs, kept current; the clock moves its durations along.
  useEffect(() => {
    let live = true;
    const load = () =>
      void runningWork()
        .then((r) => {
          if (live) setRunning(r);
        })
        .catch(() => undefined);
    load();
    const off = listen("work-changed", load).catch(() => () => undefined);
    const tick = setInterval(() => {
      setNow(Date.now());
      load();
    }, 5000);
    return () => {
      live = false;
      clearInterval(tick);
      void off.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (fallback !== null) fallbackRef.current?.select();
  }, [fallback]);

  async function copy() {
    setCopied(null);
    await flush();
    const text = await diagnosticsReport();
    const count = text.match(/^## The log: (\d+)/m)?.[1] ?? "0";
    try {
      await navigator.clipboard.writeText(text);
      setFallback(null);
      setCopied(`Copied, with ${count} entries.`);
    } catch (e) {
      // Where the clipboard isn't allowed, the text is shown, selected, to copy by hand.
      setFallback(text);
      setCopied(`The clipboard said no (${messageOf(e)}): copy the text below.`);
    }
  }

  return (
    <div className="screen ai-screen diagnostics-screen">
      <BackToSettings />
      <div className="with-info">
        <h1>Diagnostics</h1>
        {/* Spec: APP-9 */}
        <InfoButton title="Diagnostics">
          <p>
            What happened in the app on this device: every failure with its details, the work it did on your behalf and how that went, the screens it went through,
            and what its native side noted (sync, recordings, Lean, a crash).
          </p>
          <p>“Copy everything” puts all of it, with the app's version and how it's set up, on the clipboard as one text, to paste to a coding agent.</p>
          <p>It's kept for two weeks, at most 5,000 entries, on this device only. Your OpenRouter key is never in it.</p>
        </InfoButton>
        <MoreMenu
          label="More for the diagnostics"
          actions={[{ label: "Empty the log", confirm: "Really empty it?", danger: true, onClick: () => void emptyDiagnostics() }]}
        />
      </div>

      <p className="muted diag-status">
        {failures === null ? " " : failures === 0 ? "Nothing failed in the last day." : `${failures} ${failures === 1 ? "failure" : "failures"} in the last day.`}
      </p>

      <div className="diag-actions">
        <button type="button" className="button-primary" onClick={() => void copy()}>
          Copy everything
        </button>
        {copied ? (
          <span className="muted" role="status">
            {copied}
          </span>
        ) : null}
      </div>
      {fallback !== null ? <textarea ref={fallbackRef} className="diag-fallback" readOnly value={fallback} rows={10} aria-label="Everything, to copy" /> : null}

      <h2>Running now</h2>
      {running.length === 0 ? (
        <p className="muted">Nothing.</p>
      ) : (
        <ul className="diag-running">
          {running.map((r) => (
            <li key={r.id}>
              {r.title} <span className="muted">· {lasting(now - r.since)}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>What happened</h2>
      <div className="ai-filters" role="radiogroup" aria-label="Show">
        {[
          { key: null, label: "Everything" },
          { key: "failures", label: "Failures" },
        ].map((f) => (
          <button
            key={f.label}
            type="button"
            role="radio"
            aria-checked={show === f.key || (f.key === null && !failuresOnly)}
            className={(f.key === "failures") === failuresOnly ? "ai-filter active" : "ai-filter"}
            onClick={() => setShow(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {entries === null ? null : entries.length === 0 ? (
        <p className="muted">{failuresOnly ? "Nothing failed." : "Nothing yet."}</p>
      ) : (
        // As plain text, one entry a line and its details indented under it,
        // as the copy has them: selected and copied, it reads the same.
        <pre className="diag-log" aria-label="What happened">
          {entries.map(entryText).join("\n")}
        </pre>
      )}
    </div>
  );
}
