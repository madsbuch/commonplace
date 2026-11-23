import { useEffect } from "react";
import { Link } from "react-router-dom";
import { newChat, openLastChat, useAssistant } from "../lib/assistantRunner";
import { setDockOpen } from "../lib/dock";
import { ChatView } from "./ChatView";
import { InfoButton } from "./InfoButton";

// Spec: CHAT-3, ATL-1
/**
 * The assistant beside whatever is on screen, on the chat last open. It sees
 * the screen through its `look_at_screen` tool, so nothing is handed to it.
 * A column at the right on wide windows, a sheet over the screen on narrow ones.
 */
export function AssistantDock() {
  const s = useAssistant();
  useEffect(() => {
    void openLastChat();
  }, []);
  return (
    <aside className="assistant" aria-label="Assistant">
      <div className="assistant-head">
        <div className="assistant-title">
          <span className="with-info">
            <strong>Assistant</strong>
            {/* Spec: APP-9 */}
            <InfoButton title="The assistant">
              <p>Ask about what you have open, or anything in the book or the library; or pick one of the suggestions.</p>
              <p>
                It looks at your screen and what you've selected, and reads pages and PDFs by itself. It never writes or changes
                anything in the book or the library; it only keeps its chats and its memory.
              </p>
            </InfoButton>
          </span>
          <span className="assistant-page">{s.chatId ? s.title || "New chat" : "No chat open"}</span>
        </div>
        <button type="button" className="assistant-ghost" title="Start a new chat" disabled={s.status === "running"} onClick={() => void newChat()}>
          New
        </button>
        {s.chatId ? (
          <Link className="assistant-ghost" to={`/chats/${s.chatId}`} title="Open this chat on its own">
            Expand
          </Link>
        ) : null}
        <Link className="assistant-ghost" to="/chats" title="All chats">
          Chats
        </Link>
        <button type="button" className="assistant-ghost" aria-label="Close the assistant" onClick={() => setDockOpen(false)}>
          ×
        </button>
      </div>
      <ChatView />
    </aside>
  );
}
