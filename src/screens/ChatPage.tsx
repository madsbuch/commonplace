import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { ChatView } from "../components/ChatView";
import { openChat, useAssistant } from "../lib/assistantRunner";

// Spec: CHAT-2
/** One chat on its own, at `/chats/<id>`. It becomes the chat the assistant opens on. */
export default function ChatPage() {
  const { id = "" } = useParams();
  const s = useAssistant();
  useEffect(() => {
    void openChat(id);
  }, [id]);
  return (
    <div className="chat-screen">
      <div className="library-item-bar">
        <Link to="/chats">← Chats</Link>
        <span className="library-item-title">{s.chatId === id ? s.title || "New chat" : ""}</span>
      </div>
      {s.chatId === id ? <ChatView /> : null}
    </div>
  );
}
