import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { ACTION_BUTTONS, transcriptToUi, type UiItem } from "../lib/assistant";
import { retry, send, stop, useAssistant } from "../lib/assistantRunner";
import { toolLabel } from "../lib/assistantTools";
import { Markdown } from "./Markdown";
import "./Chat.css";

// Spec: CHAT-6
function Activity(props: { item: Extract<UiItem, { kind: "activity" }> }) {
  const summary = `Checked ${props.item.tools.join(" · ")}`;
  if (props.item.notes.length === 0) return <div className="chat-activity">{summary}</div>;
  return (
    <details className="chat-activity">
      <summary>{summary}</summary>
      {props.item.notes.map((n, i) => (
        <p key={i}>{n}</p>
      ))}
    </details>
  );
}

// Spec: CHAT-1, CHAT-4, CHAT-5, AST-3
/** The open chat: its thread, what's running, and the box to write in. */
export function ChatView() {
  const s = useAssistant();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => transcriptToUi(s.messages, toolLabel), [s.messages]);
  const busy = s.status === "running";
  const blocked = busy || s.status === "elsewhere";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, s.streaming, s.activeTools.length, s.status]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || blocked) return;
    setDraft("");
    void send(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat">
      <div className="assistant-body">
        {items.length === 0 && !busy ? (
          <>
            <div className="assistant-actions">
              {ACTION_BUTTONS.map((a) => (
                <button key={a.key} type="button" className="assistant-chip" disabled={blocked} onClick={() => void send(a.prompt, a.key)}>
                  {a.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <div className="assistant-log">
          {items.map((item, i) =>
            item.kind === "user" ? (
              <div key={i} className="assistant-turn user">
                {item.action ? <span className="assistant-chip static">{item.action}</span> : item.text}
              </div>
            ) : item.kind === "activity" ? (
              <Activity key={i} item={item} />
            ) : (
              <div key={i} className="assistant-turn reply">
                <Markdown text={item.text} />
              </div>
            ),
          )}
          {busy && s.activeTools.length > 0 ? <div className="chat-activity">Checking {s.activeTools.join(" · ")}…</div> : null}
          {busy && s.streaming ? (
            <div className="assistant-turn reply">
              <Markdown text={s.streaming} />
            </div>
          ) : null}
          {busy && !s.streaming && s.activeTools.length === 0 ? <div className="assistant-thinking">Thinking…</div> : null}
          {s.status === "elsewhere" ? <div className="assistant-thinking">Another device is answering this. Its answer arrives with sync.</div> : null}
          {s.status === "no-key" ? (
            <div className="assistant-error">
              The assistant uses your own OpenRouter key. <Link to="/settings/ai">Add it in Settings</Link>, then retry.{" "}
              <button type="button" className="assistant-ghost" onClick={() => void retry()}>
                Retry
              </button>
            </div>
          ) : null}
          {s.status === "error" && s.error ? (
            <div className="assistant-error">
              {s.error}{" "}
              <button type="button" className="assistant-ghost" onClick={() => void retry()}>
                Retry
              </button>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <form className="assistant-input" onSubmit={submit}>
        <textarea rows={2} value={draft} placeholder="Ask…" onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
        {busy ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button-primary" disabled={!draft.trim() || blocked}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
