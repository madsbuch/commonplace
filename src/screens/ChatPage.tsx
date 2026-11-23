import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MoreMenu } from "../components/MoreMenu";
import { ChatView } from "../components/ChatView";
import { openChat, removeChat, useAssistant } from "../lib/assistantRunner";

// Spec: CHAT-2
/** One chat on its own, at `/chats/<id>`. It becomes the chat the assistant opens on. */
export default function ChatPage() {
  const { id = "" } = useParams();
  const s = useAssistant();
  const navigate = useNavigate();
  useEffect(() => {
    void openChat(id);
  }, [id]);
  return (
    <div className="chat-screen">
      <div className="library-item-bar">
        <Link to="/chats">← Chats</Link>
        <span className="library-item-title">{s.chatId === id ? s.title || "New chat" : ""}</span>
        {/* Spec: CHAT-6, APP-12 */}
        <MoreMenu
          label="More for this chat"
          actions={[{ label: "Delete chat", confirm: "Really delete this chat?", danger: true, onClick: () => void removeChat(id).then(() => navigate("/chats", { replace: true })) }]}
        />
      </div>
      {s.chatId === id ? <ChatView /> : null}
    </div>
  );
}
