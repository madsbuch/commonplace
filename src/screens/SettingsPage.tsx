import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ModelPicker, modelSub } from "../components/ModelPicker";
import { InfoButton } from "../components/InfoButton";
import { SettingsRows } from "../components/SettingsRows";
import { getDetailsModel, saveDetailsModel } from "../lib/libraryDetails";
import {
  getApiKey,
  getAssistantModel,
  loadCachedModels,
  refreshModels,
  removeApiKey,
  saveApiKey,
  saveAssistantModel,
} from "../lib/aiSettings";
import { chat, errorMessage } from "../lib/openrouter";
import type { ORModel } from "../lib/schemas";
import { useTablesVersion } from "../lib/live";
import "./AiScreens.css";

type TestState = { status: "idle" } | { status: "testing" } | { status: "ok" } | { status: "error"; message: string };

/** "sk-or-v1-…3f9a": enough to recognise a key without showing it. */
function maskKey(key: string): string {
  return key.length <= 12 ? "…" : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

export default function SettingsPage() {
  // The key and model are synced settings: another device may change them.
  const settingsVersion = useTablesVersion(["settings"]);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<ORModel[]>([]);
  const [modelsAt, setModelsAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [detailsModel, setDetailsModel] = useState<string | null>(null);
  const [pickingDetails, setPickingDetails] = useState(false);
  const booted = useRef(false);

  useEffect(() => {
    let live = true;
    void Promise.all([getApiKey(), getAssistantModel(), getDetailsModel()]).then(([key, m, d]) => {
      if (!live) return;
      setSavedKey(key);
      setModel(m);
      setDetailsModel(d);
    });
    return () => {
      live = false;
    };
  }, [settingsVersion]);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const fresh = await refreshModels();
      setModels(fresh.models);
      setModelsAt(fresh.at);
    } catch (e) {
      setRefreshError(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  // Spec: AI-2
  // The cached list shows at once; the live one replaces it when it arrives.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void loadCachedModels().then((cached) => {
      setModels((current) => (current.length > 0 ? current : cached.models));
      setModelsAt((current) => current ?? cached.at);
    });
    void refresh();
  }, []);

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    await saveApiKey(key);
    setSavedKey(key);
    setKeyInput("");
    setShowKey(false);
    setTest({ status: "idle" });
  }

  async function remove() {
    await removeApiKey();
    setSavedKey(null);
    setConfirmRemove(false);
    setTest({ status: "idle" });
  }

  async function testConnection() {
    if (!savedKey || !model) return;
    setTest({ status: "testing" });
    try {
      await chat(savedKey, model, [{ role: "user", content: "Reply with exactly: OK" }], { feature: "connection_test" });
      setTest({ status: "ok" });
    } catch (e) {
      setTest({ status: "error", message: errorMessage(e) });
    }
  }

  async function selectModel(id: string) {
    await saveAssistantModel(id);
    setModel(id);
    setPicking(false);
    setTest({ status: "idle" });
  }

  const current = models.find((m) => m.id === model);

  return (
    <div className="screen ai-screen">
      <h1>Settings</h1>
      <SettingsRows />

      <section className="ai-section">
        <div className="with-info">
          <h2>OpenRouter</h2>
          {/* Spec: APP-9 */}
          <InfoButton title="OpenRouter">
            <p>
              The assistant and the library run on models of your choice through{" "}
              <a
                href="https://openrouter.ai/keys"
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl("https://openrouter.ai/keys");
                }}
              >
                OpenRouter
              </a>
              , with your own API key.
            </p>
            <p>The key syncs to your other devices with the book. What you ask about is sent to OpenRouter and nowhere else.</p>
          </InfoButton>
        </div>

        {savedKey ? (
          <div className="ai-row">
            <span className="ai-key">{maskKey(savedKey)}</span>
            <button type="button" className="ai-button" onClick={() => void testConnection()} disabled={test.status === "testing"}>
              {test.status === "testing" ? "Testing…" : "Test"}
            </button>
            {confirmRemove ? (
              <>
                <button type="button" className="ai-button danger" onClick={() => void remove()}>
                  Remove from all devices
                </button>
                <button type="button" className="ai-button ghost" onClick={() => setConfirmRemove(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="ai-button ghost" onClick={() => setConfirmRemove(true)}>
                Remove
              </button>
            )}
          </div>
        ) : (
          <p className="muted">No key yet.</p>
        )}
        {test.status === "ok" && <p className="ai-ok">The key works with {model}.</p>}
        {test.status === "error" && <p className="ai-error">{test.message}</p>}

        <form
          className="ai-row"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <input
            className="ai-input"
            type={showKey ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder={savedKey ? "Replace with a new key" : "sk-or-…"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button type="button" className="ai-button ghost" onClick={() => setShowKey((s) => !s)}>
            {showKey ? "Hide" : "Show"}
          </button>
          <button type="submit" className="ai-button" disabled={!keyInput.trim()}>
            Save
          </button>
        </form>
      </section>

      <section className="ai-section">
        <h2>Assistant model</h2>
        <div className="ai-row">
          <div className="model-current">
            <div className="model-name">{current?.name ?? model ?? "…"}</div>
            <div className="model-sub">{current ? modelSub(current) : model}</div>
          </div>
          <button type="button" className="ai-button ghost" onClick={() => setPicking((p) => !p)}>
            {picking ? "Done" : "Change"}
          </button>
        </div>
        {model && models.length > 0 && !current && (
          <p className="ai-error">This model isn't on OpenRouter's list any more. Pick another.</p>
        )}
        {picking && <ModelPicker models={models} selected={model ?? ""} onSelect={(id) => void selectModel(id)} />}
        <p className="muted ai-small">
          {refreshing ? "Fetching the model list…" : `Model list updated ${when(modelsAt)}.`}{" "}
          {!refreshing && (
            <button type="button" className="ai-link" onClick={() => void refresh()}>
              Refresh
            </button>
          )}
        </p>
        {refreshError && <p className="ai-error">Couldn't fetch the model list: {refreshError}</p>}
      </section>

      {/* Spec: LIB-10 */}
      <section className="ai-section">
        <div className="with-info">
          <h2>Library details model</h2>
          <InfoButton title="Library details model">
            <p>The model that reads a new paper's or book's first pages for its title, authors, institutions, year and kind.</p>
          </InfoButton>
        </div>
        <div className="ai-row">
          <div className="model-current">
            <div className="model-name">{models.find((m) => m.id === detailsModel)?.name ?? detailsModel ?? "…"}</div>
            <div className="model-sub">{(() => {
              const m = models.find((x) => x.id === detailsModel);
              return m ? modelSub(m) : detailsModel;
            })()}</div>
          </div>
          <button type="button" className="ai-button ghost" onClick={() => setPickingDetails((p) => !p)}>
            {pickingDetails ? "Done" : "Change"}
          </button>
        </div>
        {pickingDetails && (
          <ModelPicker
            models={models}
            selected={detailsModel ?? ""}
            onSelect={(id) => {
              setDetailsModel(id);
              setPickingDetails(false);
              void saveDetailsModel(id);
            }}
          />
        )}
      </section>

    </div>
  );
}
