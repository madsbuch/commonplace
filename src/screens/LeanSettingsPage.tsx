import { useEffect, useRef, useState } from "react";
import { InfoButton } from "../components/InfoButton";
import { BackToSettings } from "../components/SettingsRows";
import { leanSetUp, leanStatus, leanVersion, runsLean } from "../lib/lean";
import type { LeanServiceStatus } from "../lib/schemas";
import "./AiScreens.css";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Spec: APP-8, LEAN-7, LEAN-8
/** Settings → Lean: whether this computer can verify Lean blocks, and setting it up. */
export default function LeanSettingsPage() {
  const computer = runsLean();
  const [status, setStatus] = useState<LeanServiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  const refresh = () =>
    leanStatus()
      .then((s) => {
        setStatus(s);
        setRunning(s.settingUp);
      })
      .catch((e: unknown) => setError(errorText(e)));

  useEffect(() => {
    if (computer) void refresh();
    return () => stop.current?.();
  }, [computer]);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "nearest" }), [log]);

  async function setUp() {
    setError(null);
    setLog([]);
    setRunning(true);
    try {
      stop.current = await leanSetUp(
        (line) => setLog((l) => [...l.slice(-400), line]),
        (err) => {
          setRunning(false);
          setError(err);
          stop.current?.();
          stop.current = null;
          void refresh();
        },
      );
    } catch (e) {
      setRunning(false);
      setError(errorText(e));
    }
  }

  return (
    <div className="screen ai-screen">
      <BackToSettings />
      <div className="with-info">
        <h1>Lean</h1>
        {/* Spec: APP-9 */}
        <InfoButton title="Lean">
          <p>
            Lean blocks in the book are verified by Lean, with Mathlib, on your computers: as you edit them there, and by themselves when a block
            changed on another device. What a computer found syncs to every device.
          </p>
          <p>Phones don't run Lean: there you write and read Lean blocks, and see what your computers found.</p>
          <p>
            Each computer keeps a Lean workspace with Mathlib in the app's data folder. Lean itself comes from elan, Lean's installer, which you
            install once.
          </p>
        </InfoButton>
      </div>

      {!computer ? (
        <p>This phone doesn't run Lean.</p>
      ) : status === null ? null : (
        <section className="ai-section">
          {!status.lake ? (
            <>
              <div className="with-info">
                <p className="lean-setting-line">Lean isn't installed on this computer.</p>
                <InfoButton title="Installing Lean">
                  <p>Install elan, Lean's installer, from a terminal:</p>
                  <pre className="lean-command">curl https://elan.lean-lang.org/elan-init.sh -sSf | sh</pre>
                  <p>Then come back here and set up Lean and Mathlib.</p>
                </InfoButton>
              </div>
              <div className="ai-row">
                <button type="button" className="ai-button ghost" onClick={() => void refresh()}>
                  Look again
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="with-info">
                <p className="lean-setting-line">
                  {running
                    ? "Setting up Lean and Mathlib…"
                    : status.ready
                      ? `Ready: Lean ${leanVersion(status.toolchain)}, with Mathlib.`
                      : "Lean is installed; Mathlib isn't set up here yet."}
                </p>
                <InfoButton title="Setting up">
                  <p>
                    Setting up fetches Mathlib at its latest, the Lean it needs, and Mathlib's compiled files: several GB, once. It takes a while;
                    the app can stay open meanwhile.
                  </p>
                  <p>Setting up again moves to the latest Mathlib.</p>
                  <p className="muted">{status.workspace}</p>
                </InfoButton>
              </div>
              {!running ? (
                <div className="ai-row">
                  <button type="button" className="ai-button" onClick={() => void setUp()}>
                    {status.ready ? "Set up again" : "Set up Lean and Mathlib"}
                  </button>
                </div>
              ) : null}
            </>
          )}
          {error ? <p className="ai-error">{error}</p> : null}
          {log.length > 0 ? (
            <pre className="lean-log" aria-label="Setting up">
              {log.join("\n")}
              <div ref={logEnd} />
            </pre>
          ) : null}
        </section>
      )}
    </div>
  );
}
