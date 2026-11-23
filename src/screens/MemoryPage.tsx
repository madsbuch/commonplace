import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { InfoButton } from "../components/InfoButton";
import { useTablesVersion } from "../lib/live";
import { deleteMemory, isMemoryKind, listMemory, MEMORY_KIND_NAMES, MEMORY_KINDS, updateMemory, addMemory, type MemoryEntry } from "../lib/memory";

function Entry(props: { entry: MemoryEntry }) {
  const [text, setText] = useState(props.entry.text);
  useEffect(() => setText(props.entry.text), [props.entry.text]);
  return (
    <li className="memory-entry">
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() && text !== props.entry.text) void updateMemory(props.entry.id, { text });
        }}
      />
      <select
        value={props.entry.kind}
        onChange={(e) => {
          const kind = e.target.value;
          if (isMemoryKind(kind)) void updateMemory(props.entry.id, { kind });
        }}
      >
        {MEMORY_KINDS.map((k) => (
          <option key={k} value={k}>
            {MEMORY_KIND_NAMES[k]}
          </option>
        ))}
      </select>
      {/* Spec: APP-12 — only while the entry is being edited. */}
      <button type="button" className="memory-forget" onClick={() => void deleteMemory(props.entry.id)}>
        Forget
      </button>
    </li>
  );
}

// Spec: MEM-3
/** What the assistant remembers across chats: read, edit, delete, add. */
export default function MemoryPage() {
  const version = useTablesVersion(["assistant_memory"]);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    let live = true;
    void listMemory().then((m) => {
      if (live) setEntries(m);
    });
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <div className="screen">
      <Link to="/chats" className="back-link">
        ← Chats
      </Link>
      <div className="with-info">
        <h1>Memory</h1>
        {/* Spec: APP-9 */}
        <InfoButton title="The assistant's memory">
          <p>What the assistant knows in every chat. It adds to this when you ask it to remember something, or tell it how you want to be helped.</p>
          <p>Deleting a chat keeps the memory. Edit or delete anything here.</p>
        </InfoButton>
      </div>
      {MEMORY_KINDS.map((k) => {
        const of = (entries ?? []).filter((e) => e.kind === k);
        return (
          <section key={k}>
            <h2 className="memory-kind">{MEMORY_KIND_NAMES[k]}</h2>
            {of.length === 0 ? <p className="muted">Nothing yet.</p> : null}
            <ul className="memory-list">
              {of.map((e) => (
                <Entry key={e.id} entry={e} />
              ))}
            </ul>
          </section>
        );
      })}
      <form
        className="memory-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void addMemory("note", draft).then(() => setDraft(""));
        }}
      >
        <input value={draft} placeholder="Add a note for the assistant" onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
