import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ASSISTANT_ACTIONS, actionLabel, actionTurn, buildMessages, type AssistantActionKey, type Turn } from "../lib/assistant";
import { getApiKey, getAssistantModel } from "../lib/aiSettings";
import { chat, errorMessage } from "../lib/openrouter";
import "./AssistantPanel.css";

export interface AssistantPanelProps {
  pageId: string;
  pageTitle: string;
  /** The page as Markdown, read afresh before every request. */
  getPageMarkdown: () => Promise<string>;
  onClose: () => void;
}

// Spec: AST-1, AST-2, AST-3, AI-6
/**
 * The writing assistant beside a page. It reads the page (as Markdown handed
 * in by the page screen) and answers beside it: questions, critique, gaps,
 * sources, quizzes, and follow-up conversation about those. It has no way to
 * change the book: nothing here writes anything but the usage ledger, and
 * there is no "insert" or "apply". The conversation lives only as long as
 * the panel; a new page starts a new one.
 *
 * Laid out as a column meant to sit at the right of the page screen
 * (`display: flex` row); under 760px it covers the screen as a sheet.
 */
export function AssistantPanel(props: AssistantPanelProps) {
  const { pageId, pageTitle, getPageMarkdown, onClose } = props;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const busy = streaming !== null;

  // A new page is a new conversation.
  useEffect(() => {
    abortRef.current?.abort();
    setTurns([]);
    setStreaming(null);
    setError(null);
  }, [pageId]);

  useEffect(() => {
    let live = true;
    void Promise.all([getApiKey(), getAssistantModel()]).then(([key, m]) => {
      if (!live) return;
      setHasKey(key !== null);
      setModel(m);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, streaming]);

  async function ask(next: Turn[]) {
    setError(null);
    setTurns(next);
    setStreaming("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const key = await getApiKey();
      if (!key) {
        setHasKey(false);
        throw new Error("Add your OpenRouter key in Settings to use the assistant.");
      }
      const chosen = await getAssistantModel();
      setModel(chosen);
      const markdown = await getPageMarkdown();
      const answer = await chat(key, chosen, buildMessages(pageTitle, markdown, next), {
        feature: "assistant",
        signal: controller.signal,
        onText: (text) => {
          if (!controller.signal.aborted) setStreaming(text);
        },
      });
      if (!controller.signal.aborted) setTurns([...next, { role: "assistant", content: answer }]);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(null);
      }
    }
  }

  function runAction(key: AssistantActionKey) {
    if (busy) return;
    void ask([...turns, actionTurn(key)]);
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void ask([...turns, { role: "user", content: text }]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function stop() {
    const controller = abortRef.current;
    if (!controller) return;
    controller.abort();
    abortRef.current = null;
    // Keep what had arrived, so a long answer cut short isn't lost.
    if (streaming) setTurns((t) => [...t, { role: "assistant", content: `${streaming}\n\n*(stopped)*` }]);
    setStreaming(null);
  }

  function restart() {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns([]);
    setStreaming(null);
    setError(null);
  }

  return (
    <aside className="assistant" aria-label="Writing assistant">
      <header className="assistant-head">
        <div className="assistant-title">
          <strong>Assistant</strong>
          <span className="assistant-page" title={pageTitle}>
            {pageTitle || "Untitled"}
          </span>
        </div>
        {turns.length > 0 && (
          <button type="button" className="assistant-ghost" onClick={restart} title="Start a new conversation">
            New
          </button>
        )}
        <button type="button" className="assistant-ghost" onClick={onClose} aria-label="Close the assistant">
          ✕
        </button>
      </header>

      <div className="assistant-body">
        {hasKey === false && (
          <p className="assistant-note">
            The assistant uses your own OpenRouter key. <Link to="/settings">Add it in Settings</Link>.
          </p>
        )}

        {turns.length === 0 && hasKey !== false && (
          <p className="assistant-note">
            It reads this page and helps you think about it. It never writes the book for you.
          </p>
        )}

        <div className="assistant-actions">
          {ASSISTANT_ACTIONS.map((a) => (
            <button key={a.key} type="button" className="assistant-chip" disabled={busy} onClick={() => runAction(a.key)}>
              {a.label}
            </button>
          ))}
        </div>

        <div className="assistant-log">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="assistant-turn user">
                {t.action ? <span className="assistant-chip static">{actionLabel(t.action)}</span> : t.content}
              </div>
            ) : (
              <div key={i} className="assistant-turn reply">
                <Reply text={t.content} />
              </div>
            ),
          )}
          {streaming !== null && (
            <div className="assistant-turn reply">
              {streaming === "" ? <span className="assistant-thinking">Reading the page…</span> : <Reply text={streaming} />}
            </div>
          )}
          {error && <div className="assistant-error">{error}</div>}
          <div ref={endRef} />
        </div>
      </div>

      <form className="assistant-input" onSubmit={send}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={turns.length > 0 ? "Answer or ask a follow-up…" : "Ask about this page…"}
        />
        {busy ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
      {model && (
        <div className="assistant-foot">
          <Link to="/settings">{model}</Link>
        </div>
      )}
    </aside>
  );
}

/** An answer, as Markdown with maths. Links open in the system browser, never in the app's window. */
function Reply({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (href && /^https?:\/\//.test(href)) void openUrl(href);
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
