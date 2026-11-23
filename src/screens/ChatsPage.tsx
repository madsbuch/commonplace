import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CHAT_TABLES, listChats, type ChatSummary } from "../lib/chats";
import { newChat } from "../lib/assistantRunner";
import { useTablesVersion } from "../lib/live";

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Spec: CHAT-1
/** Every chat, newest first: open one, or start one. A chat is deleted from its own menu (APP-12). */
export default function ChatsPage() {
  const version = useTablesVersion(CHAT_TABLES);
  const navigate = useNavigate();
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    void listChats().then((c) => {
      if (live) setChats(c);
    });
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <div className="screen">
      <div className="library-head">
        <h1>Chats</h1>
        <div className="page-actions">
          <Link to="/memory" className="button-link">
            Memory
          </Link>
          <button type="button" className="button-primary" onClick={() => void newChat().then((id) => navigate(`/chats/${id}`))}>
            New chat
          </button>
        </div>
      </div>
      {chats && chats.length === 0 ? <p className="muted">No chats yet.</p> : null}
      <ul className="library-list">
        {(chats ?? []).map((c) => (
          <li key={c.id} className="chat-row">
            <Link to={`/chats/${c.id}`} className="library-row">
              <span className="library-title">{c.title}</span>
              <span className="library-meta muted">{when(c.updatedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
