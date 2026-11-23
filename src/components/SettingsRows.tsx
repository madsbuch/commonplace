import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatUsd, localDay, totalOf } from "../lib/aiCost";
import { getApiKey, getAssistantModel, loadCachedModels } from "../lib/aiSettings";
import { loadUsageRows } from "../lib/aiUsage";
import { useTablesVersion } from "../lib/live";
import { listMemory } from "../lib/memory";
import { copyLine, copyState, getSyncStatus, onSyncStatus } from "../lib/sync";
import { ChatIcon, CostIcon, KeyIcon, LeanIcon, PulseIcon, SyncIcon } from "./Icons";
import { failuresSince } from "../lib/diagnostics";
import { leanStatus, leanVersion, runsLean } from "../lib/lean";
import { ThemeSwitch } from "./ThemeSwitch";

function Row(props: { to: string; icon: React.JSX.Element; title: string; line: string | null }) {
  return (
    <Link to={props.to} className="settings-row">
      <span className="settings-row-icon">{props.icon}</span>
      <span className="settings-row-main">
        <span className="settings-row-title">{props.title}</span>
        <span className="settings-row-line">{props.line ?? " "}</span>
      </span>
      <span className="settings-row-end" aria-hidden>
        ›
      </span>
    </Link>
  );
}

// Spec: APP-8
/** Settings' ways into the pages nested in it, each with a line on how it stands. */
export function SettingsRows() {
  const [sync, setSync] = useState<string | null>(null);
  const [spend, setSpend] = useState<string | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const [ai, setAi] = useState<string | null>(null);
  const [lean, setLean] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const version = useTablesVersion(["ai_usage", "assistant_memory", "settings", "diagnostics"]);

  useEffect(() => {
    let live = true;
    const load = () =>
      getSyncStatus()
        .then((s) => {
          if (live) setSync(copyLine(copyState(s)));
        })
        .catch(() => {
          if (live) setSync("Not available here");
        });
    void load();
    const off = onSyncStatus(load);
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    let live = true;
    const month = localDay().slice(0, 7);
    void loadUsageRows()
      .then((rows) => {
        if (live) setSpend(`${formatUsd(totalOf(rows.filter((r) => r.day.startsWith(month))).costUsd)} this month`);
      })
      .catch(() => undefined);
    void Promise.all([getApiKey(), getAssistantModel(), loadCachedModels()])
      .then(([key, model, cached]) => {
        const name = cached.models.find((m) => m.id === model)?.name ?? model;
        if (live) setAi(key ? `Key set · ${name}` : "No OpenRouter key yet");
      })
      .catch(() => undefined);
    // Spec: LEAN-7, LEAN-8
    if (!runsLean()) setLean("Verified on your computers");
    else
      void leanStatus()
        .then((s) => {
          if (live) setLean(s.settingUp ? "Setting up…" : s.ready ? `Ready · Lean ${leanVersion(s.toolchain)}` : s.lake ? "Not set up on this computer" : "Lean isn't installed here");
        })
        .catch(() => {
          if (live) setLean("Not available here");
        });
    // Spec: DIAG-3
    void failuresSince(Date.now() - 24 * 60 * 60 * 1000)
      .then((n) => {
        if (live) setDiagnostics(n === 0 ? "Nothing failed in the last day" : `${n} ${n === 1 ? "failure" : "failures"} in the last day`);
      })
      .catch(() => undefined);
    void listMemory()
      .then((m) => {
        if (live) setMemory(m.length === 0 ? "Nothing remembered yet" : `${m.length} thing${m.length === 1 ? "" : "s"} remembered`);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <section className="settings-rows">
      <Row to="/settings/ai" icon={<KeyIcon />} title="AI and models" line={ai} />
      <Row to="/settings/lean" icon={<LeanIcon />} title="Lean" line={lean} />
      <Row to="/settings/sync" icon={<SyncIcon />} title="Sync" line={sync} />
      <Row to="/settings/costs" icon={<CostIcon />} title="AI costs" line={spend} />
      <Row to="/memory" icon={<ChatIcon />} title="The assistant's memory" line={memory} />
      <Row to="/settings/diagnostics" icon={<PulseIcon />} title="Diagnostics" line={diagnostics} />
      <div className="settings-row static">
        <span className="settings-row-main">
          <span className="settings-row-title">Appearance</span>
          <span className="settings-row-line">Light, dark, or as the system is, on this device</span>
        </span>
        <ThemeSwitch />
      </div>
    </section>
  );
}

/** "← Settings", at the top of a page nested in Settings. */
export function BackToSettings() {
  return (
    <Link to="/settings" className="back-link">
      ← Settings
    </Link>
  );
}
